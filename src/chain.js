var CryptoJS = require("crypto-js");
const { randomBytes } = require('crypto')
const secp256k1 = require('secp256k1')
const bs58 = require('bs58')
const series = require('run-series')

var TransactionType = {
    NEW_ACCOUNT: 0,
    APPROVE_NODE_OWNER: 1,
    DISAPROVE_NODE_OWNER: 2,
    TRANSFER: 3,
    COMMENT: 4,
    VOTE: 5,
    EDIT_USER_JSON: 6,
    RESTEEM: 7, // not sure
};

class Block {
    constructor(index, phash, timestamp, txs, miner, signature, hash) {
        this._id = index;
        this.phash = phash.toString();
        this.timestamp = timestamp;
        this.txs = txs;
        this.miner = miner;
        this.hash = hash;
        this.signature = signature;
    }
}

chain = {
    getNewKeyPair: () => {
        const msg = randomBytes(32)
        let privKey, pubKey
        do {
            privKey = randomBytes(32)
            pubKey = secp256k1.publicKeyCreate(privKey)
        } while (!secp256k1.privateKeyVerify(privKey))
    
        return {
            pub: bs58.encode(pubKey),        
            priv: bs58.encode(privKey)
        }
    },
    getGenesisBlock: (data) => {
        return new Block(
            0,
            "0",
            0,
            [],
            "master",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000000"
        );
    },
    prepareBlock: () => {
        var previousBlock = chain.getLatestBlock()
        var nextIndex = previousBlock._id + 1
        var nextTimestamp = new Date().getTime()
        // grab transactions and empty it
        var txs = tempTxs.sort(function(a,b){return a.ts-b.ts})
        tempTxs = []
        return new Block(nextIndex, previousBlock.hash, nextTimestamp, txs, null, null, null);
    },
    hashAndSignBlock: (block) => {
        var miner = process.env.NODE_OWNER
        var nextHash = chain.calculateHash(block._id, block.phash, block.timestamp, block.txs, miner);
        var signature = secp256k1.sign(new Buffer(nextHash, "hex"), bs58.decode(process.env.NODE_OWNER_PRIV));
        signature = bs58.encode(signature.signature)
        return new Block(block._id, block.phash, block.timestamp, block.txs, miner, signature, nextHash);
        
    },
    mineBlock: (cb) => {
        var newBlock = chain.prepareBlock()
        chain.executeTransactions(newBlock, function(validTxs) {
            newBlock.txs = validTxs
            newBlock = chain.hashAndSignBlock(newBlock)

            chain.isValidNewBlock(newBlock, function(isValid) {
                if (!isValid)
                    cb(true, newBlock); return
    
                chain.addBlock(newBlock, function(added) {
                    cb(null, newBlock)
                    // and broadcast to p2p TODO
                    // if (added)
                    //     p2p.broadcast...
                })
            })
        })
    },
    addBlock: (block, cb) => {
        // add the block in our own db
        db.collection('blocks').insertOne(block, function(err) {
            if (err) throw err;
            tempBlocks.push(block)

            // if block id is mult of 20, reschedule next 20 blocks
            if (block._id%20 == 0) {
                chain.minerSchedule(block, function(minerSchedule) {
                    schedule = minerSchedule
                })
            }

            cb(true)
        });
    },
    isValidSignature: (user, hash, sign, cb) => {
        // verify signature
        db.collection('accounts').findOne({name: user}, function(err, account) {
            if (err) throw err;
            var minerPub = account.pub;
            if (secp256k1.verify(
                new Buffer(hash, "hex"),
                bs58.decode(sign),
                bs58.decode(minerPub)))
                cb(true)
            else
                cb(false)
        })
    },
    isValidNewBlock: (newBlock, cb) => {
        // check if miner isnt trying to fast forward time
        if (newBlock.timestamp > new Date().getTime()) {
            console.log('timestamp from the future')
            cb(false); return
        }

        // check if new block isnt too early
        if (newBlock.timestamp - chain.getLatestBlock().timestamp < 3000) {
            console.log('block too early')
            cb(false); return
        }

        // check if miner is scheduled witness
        var isMinerAuthorized = false;
        if (schedule.shuffle[(newBlock._id-1)%20].name == newBlock.miner) {
            isMinerAuthorized = true;
        } else if (newBlock.miner == chain.getLatestBlock().miner) {
            // allow the previous miner to mine again if current miner misses the block
            if (newBlock.timestamp - chain.getLatestBlock().timestamp < 6000) {
                console.log('block too early for backup witness')
                cb(false); return
            } else {
                isMinerAuthorized = true;
                newBlock.missedBy = schedule.shuffle[(newBlock._id-1)%20].name
            }
        }
        
        if (!isMinerAuthorized) {
            console.log('unauthorized miner')
            cb(false); return
        }

        chain.isValidSignature(newBlock.miner, newBlock.hash, newBlock.signature, function(isSigned) {
            if (!isSigned) {
                console.log('invalid signature')
                cb(false); return
            }

            var previousBlock = chain.getLatestBlock()
            if (previousBlock._id + 1 !== newBlock._id) {
                console.log('invalid index')
                cb(false); return
            }
            if (previousBlock.hash !== newBlock.phash) {
                console.log('invalid phash')
                cb(false); return
            }
            var theoreticalHash = chain.calculateHashForBlock(newBlock)
            if (theoreticalHash !== newBlock.hash) {
                console.log(typeof (newBlock.hash) + ' ' + typeof theoreticalHash)
                console.log('invalid hash: ' + theoreticalHash + ' ' + newBlock.hash)
                cb(false); return
            }
            cb(true)
        })
    },
    isPublishedTx: (tx) => {
        if (!tx.hash) return
        for (let i = 0; i < tempBlocks.length; i++) {
            const txs = tempBlocks[i].txs
            for (let y = 0; y < txs.length; y++) {
                if (txs[y].hash == tx.hash)
                    return true
            }
        }
        return false
    },
    isValidTx: (tx, cb) => {
        if (!tx.sender || !tx.hash || !tx.signature || !tx.ts) {
            console.log('missing required variable')
            cb(false); return
        }

        // avoid transaction reuse
        // check if we are within 1 minute of timestamp seed
        if (Math.abs(new Date().getTime() - tx.ts) > 60000) {
            console.log('invalid timestamp')
            cb(false); return
        }
        // check if this tx hash was already added to chain recently
        if (chain.isPublishedTx(tx)) {
            console.log('transaction already in chain')
            cb(false); return
        }

        // checking transaction signature
        chain.isValidSignature(tx.sender, tx.hash, tx.signature, function(isSigned) {
            if (!isSigned) {
                console.log('invalid signature')
                cb(false); return
            }
            // check transaction specifics
            switch (tx.type) {
                case TransactionType.NEW_ACCOUNT:
                    if (!tx.data.name
                    || !tx.data.pub
                    || tx.sender != 'master') {
                        cb(false); return
                    }

                    db.collection('accounts').findOne({name: tx.data.name}, function(err, account) {
                        if (err) throw err;
                        if (account)
                            cb(false)
                        else
                            cb(true)
                    })
                    break;
                
                case TransactionType.APPROVE_NODE_OWNER:
                    if (!tx.data.target) {
                        cb(false); return
                    }

                    db.collection('accounts').findOne({name: tx.sender}, function(err, account) {
                        if (err) throw err;
                        if (account.approves.indexOf(tx.data.target) > -1) {
                            cb(false); return
                        }
                        if (account.approves.length >= 5)
                            cb(false)
                        else {
                            db.collection('accounts').findOne({name: tx.data.target}, function(err, account) {
                                if (!account) {
                                    cb(false)
                                } else {
                                    cb(true)
                                }
                            })
                        }
                    })
                    break;

                case TransactionType.DISAPROVE_NODE_OWNER:
                    if (!tx.data.target) {
                        cb(false); return
                    }

                    db.collection('accounts').findOne({name: tx.sender}, function(err, account) {
                        if (err) throw err;
                        if (account.approves.indexOf(tx.data.target) == -1) {
                            cb(false); return
                        }
                        db.collection('accounts').findOne({name: tx.data.target}, function(err, account) {
                            if (!account) {
                                cb(false)
                            } else {
                                cb(true)
                            }
                        })
                    })
                    break;

                case TransactionType.TRANSFER:
                    if (!tx.data.receiver
                    || !tx.data.amount) {
                        cb(false); return
                    }
                    db.collection('accounts').findOne({name: tx.sender}, function(err, account) {
                        if (err) throw err;
                        if (account.balance < tx.data.amount)
                            cb(false)
                        else {
                            db.collection('accounts').findOne({name: tx.data.receiver}, function(err, account) {
                                if (err) throw err;
                                if (!account) cb(false)
                                else cb(true)
                            })
                        }
                    })
                    break;

                default:
                    cb(false)
                    break;
            }
        })
    },
    executeTransaction: (tx, cb) => {
        switch (tx.type) {
            case TransactionType.NEW_ACCOUNT:
                db.collection('accounts').insertOne({
                    name: tx.data.name,
                    pub: tx.data.pub,
                    balance: 0
                }).then(function(){
                    cb(true)
                })
                break;

            case TransactionType.APPROVE_NODE_OWNER:
                db.collection('accounts').updateOne(
                    {name: tx.sender},
                    {$push: {approves: tx.data.target}},
                function() {
                    db.collection('accounts').findOne({name: tx.sender}, function(err, acc) {
                        if (err) throw err;
                        var node_appr = Math.floor(acc.balance/acc.approves.length)
                        var node_appr_before = Math.floor(acc.balance/(acc.approves.length-1))
                        var node_owners = []
                        for (let i = 0; i < acc.approves.length; i++)
                            if (acc.approves[i] != tx.data.target)
                                node_owners.push(acc.approves[i])

                        db.collection('accounts').updateMany(
                            {name: {$in: node_owners}},
                            {$inc: {node_appr: node_appr-node_appr_before}}, function() {
                            db.collection('accounts').updateOne(
                                {name: tx.data.target},
                                {$inc: {node_appr: node_appr}}, function() {
                                    cb(true)
                                }
                            )
                        })
                    })
                })
                break;

            case TransactionType.DISAPROVE_NODE_OWNER:
                db.collection('accounts').updateOne(
                    {name: tx.sender},
                    {$pull: {approves: tx.data.target}},
                function() {
                    db.collection('accounts').findOne({name: tx.sender}, function(err, acc) {
                        if (err) throw err;
                        var node_appr = Math.floor(acc.balance/acc.approves.length)
                        var node_appr_before = Math.floor(acc.balance/(acc.approves.length+1))
                        var node_owners = []
                        for (let i = 0; i < acc.approves.length; i++)
                            if (acc.approves[i] != tx.data.target)
                                node_owners.push(acc.approves[i])

                        db.collection('accounts').updateMany(
                            {name: {$in: node_owners}},
                            {$inc: {node_appr: node_appr-node_appr_before}}, function() {
                            db.collection('accounts').updateOne(
                                {name: tx.data.target},
                                {$inc: {node_appr: -node_appr}}, function() {
                                    cb(true)
                                }
                            )
                        })
                    })
                })
                break;

            case TransactionType.TRANSFER:
                // remove funds from sender
                db.collection('accounts').updateOne(
                    {name: tx.sender},
                    {$inc: {balance: -tx.data.amount}},
                function() {
                    // and update his node_owners approvals values
                    db.collection('accounts').findOne({name: tx.sender}, function(err, acc) {
                        if (err) throw err;
                        var node_appr = Math.floor(acc.balance/acc.approves.length)
                        var node_appr_before = Math.floor((acc.balance+tx.data.amount)/acc.approves.length)
                        var node_owners = []
                        for (let i = 0; i < acc.approves.length; i++)
                            node_owners.push(acc.approves[i])
                        db.collection('accounts').updateMany(
                            {name: {$in: node_owners}},
                            {$inc: {node_appr: node_appr-node_appr_before}}
                        ).then(function() {
                            cb(true)
                        })
                    })
                })

                // add funds to receiver
                db.collection('accounts').updateOne(
                    {name: tx.data.receiver},
                    {$inc: {balance: tx.data.amount}},
                function() {
                    // and update his node_owners approvals values too
                    db.collection('accounts').findOne({name: tx.data.receiver}, function(err, acc) {
                        if (err) throw err;
                        if (!acc.approves) acc.approves = []
                        var node_appr = Math.floor(acc.balance/acc.approves.length)
                        var node_appr_before = Math.floor((acc.balance+tx.data.amount)/acc.approves.length)
                        var node_owners = []
                        for (let i = 0; i < acc.approves.length; i++)
                            node_owners.push(acc.approves[i])
                        db.collection('accounts').updateMany(
                            {name: {$in: node_owners}},
                            {$inc: {node_appr: node_appr-node_appr_before}}
                        )
                    })
                })

                break;

            default:
                cb(false)
                break;
        }
    },
    executeTransactions: (block, cb) => {
        // count how many missed blocks by witnesses
        if (block.missedBy) {
            db.collection('accounts').updateOne(
                {name: block.missedBy},
                {$inc: {missedBlocks: 1}}
            )
        }

        var executions = []
        for (let i = 0; i < block.txs.length; i++) {
            executions.push(function(callback) {
                var transaction = block.txs[i]
                chain.isValidTx(transaction, function(isValid) {
                    if (isValid) {
                        chain.executeTransaction(transaction, function(executed) {
                            callback(null, executed)
                        })
                    } else {
                        callback(null, false)
                    }
                })
                i++
            })
        }
        var i = 0
        series(executions, function(err, results) {
            if (err) throw err;
            var executedSuccesfully = []
            for (let i = 0; i < results.length; i++) {
                if (results[i] != true)
                    console.log('non-executed tx', i, block.txs[i])
                else
                    executedSuccesfully.push(block.txs[i])
            }
                
            cb(executedSuccesfully)
        })
    },
    minerSchedule: (block, cb) => {
        var hash = block.hash
        console.log('Generating miners schedule ' + hash)
        var rand = parseInt("0x"+hash.substr(hash.length-6))
        chain.generateTop20Witness(function(miners) {
            var shuffledMiners = []
            while (miners.length > 0) {
                var i = rand%miners.length
                shuffledMiners.push(miners[i])
                miners.splice(i, 1)
            }
            
            var i = 0;
            while (shuffledMiners.length < 20) {
                shuffledMiners.push(shuffledMiners[0])
                i++
            }
            cb({
                block: block,
                shuffle: shuffledMiners
            })
        })
    },
    generateTop20Witness: (cb) => {
        db.collection('accounts').find({node_appr: {$gt: 0}}, {
            sort: {node_appr: -1},
            limit: 20
        }).toArray(function(err, accounts) {
            if (err) throw err;
            cb(accounts)
        })
    },
    calculateHashForBlock: (block) => {
        return chain.calculateHash(block._id, block.phash, block.timestamp, block.txs, block.miner);
    },
    calculateHash: (index, phash, timestamp, txs, miner) => {
        return CryptoJS.SHA256(index + phash + timestamp + txs + miner).toString();
    },    
    // handleBlockchainResponse: (message) => {
    //     var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    //     var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    //     var latestBlockHeld = getLatestBlock();
    //     if (latestBlockReceived.index > latestBlockHeld.index) {
    //         console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
    //         if (latestBlockHeld.hash === latestBlockReceived.phash) {
    //             console.log("We can append the received block to our chain");
    //             db.collection('blocks').insertOne(latestBlockReceived);
    //             broadcast(responseLatestMsg());
    //         } else if (receivedBlocks.length === 1) {
    //             console.log("We have to query the chain from our peer");
    //             broadcast(queryAllMsg());
    //         } else {
    //             console.log("WTF IS THIS?? Received blockchain is longer than current blockchain");
    //             //replaceChain(receivedBlocks);
    //         }
    //     } else {
    //         console.log('received blockchain is not longer than current blockchain. Do nothing');
    //     }
    // },
    
    // isValidChain: (blockchainToValidate) => {
    //     if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
    //         return false;
    //     }
    //     var tempBlocks = [blockchainToValidate[0]];
    //     for (var i = 1; i < blockchainToValidate.length; i++) {
    //         if (isValidNewBlock(blockchainToValidate[i])) {
    //             tempBlocks.push(blockchainToValidate[i]);
    //         } else {
    //             return false;
    //         }
    //     }
    //     return true;
    // },
    
    getLatestBlock: () => {
        return tempBlocks[tempBlocks.length-1]
    }
}

module.exports = chain