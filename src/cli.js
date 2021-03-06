var command = process.argv[2]
var CryptoJS = require("crypto-js")
const { randomBytes } = require('crypto')
const secp256k1 = require('secp256k1')
const bs58 = require('bs58')

switch (command) {
    case 'keypair':
        const msg = randomBytes(32)
        let priv, pub
        do {
            priv = randomBytes(32)
            pub = secp256k1.publicKeyCreate(priv)
        } while (!secp256k1.privateKeyVerify(priv))
    
        var tx = {
            pub: bs58.encode(pub),        
            priv: bs58.encode(priv)
        }
        break;
    case 'sign':
        // usage: npm run cli sign <privKey> <username> <raw_transaction>
        // will return a new transaction with a hash and a signature
        var privKey = process.argv[3]
        var sender = process.argv[4]
        var tx = process.argv[5]
        tx = JSON.parse(tx)
        tx.sender = sender
        // add timestamp to seed the hash (avoid transactions reuse)
        tx.ts = new Date().getTime()
        // hash the transaction
        tx.hash = CryptoJS.SHA256(JSON.stringify(tx)).toString()
        // sign the transaction
        var signature = secp256k1.sign(new Buffer(tx.hash, "hex"), bs58.decode(privKey))
        tx.signature = bs58.encode(signature.signature)
        
        break;

    default:
        break;
}
console.log(JSON.stringify(tx))