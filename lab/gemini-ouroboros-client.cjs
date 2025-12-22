const net = require('net');
const cbor = require('cbor');

// --- Configuration ---
const CONFIG = {
    // We use the Cardano Foundation backbone which is reliable
    host: 'backbone.mainnet.cardanofoundation.org',
    port: 3001,
    magic: 764824073, // Mainnet Magic
};

// --- Constants ---
const PROTOCOL = { HANDSHAKE: 0, CHAIN_SYNC: 2 };
const MSG_HANDSHAKE = { PROPOSE: 0, ACCEPT: 1, REFUSE: 2 };
const MSG_CHAIN_SYNC = { FIND_INTERSECT: 4, INTERSECT_FOUND: 5, INTERSECT_NOT_FOUND: 6 };

// --- Manual CBOR Construction (Strict Definite Length) ---
// We manually build the bytes to avoid 'cbor' library defaults (indefinite length) 
// that cause the node to disconnect (ECONNRESET).

function buildHandshakePayload() {
    // We will propose NodeToNode V10 and V13.
    
    // 1. Build Version Data V10: [Magic(Int), InitiatorOnly(Bool)]
    // Array(2) + Int(Magic) + True
    const v10Data = Buffer.concat([
        Buffer.from('82', 'hex'),               // Array(2)
        Buffer.from('1A2D964A09', 'hex'),       // Int(764824073)
        Buffer.from('F5', 'hex')                // Bool(True)
    ]);

    // 2. Build Version Data V13: [Magic(Int), DiffusionMode(Bool), PeerSharing(Int), Query(Bool)]
    // Array(4) + Int(Magic) + True + Int(0) + False
    const v13Data = Buffer.concat([
        Buffer.from('84', 'hex'),               // Array(4)
        Buffer.from('1A2D964A09', 'hex'),       // Int(764824073)
        Buffer.from('F5', 'hex'),               // Bool(True - InitiatorOnly)
        Buffer.from('00', 'hex'),               // Int(0) - No Peer Sharing
        Buffer.from('F4', 'hex')                // Bool(False) - No Query
    ]);

    // 3. Build the Version Map: { 10: v10Data, 13: v13Data }
    // Map(2)
    const versionMapHeader = Buffer.from('A2', 'hex'); // Map(2)
    
    const entryV10 = Buffer.concat([
        Buffer.from('0A', 'hex'), // Key: 10
        v10Data                   // Value
    ]);

    const entryV13 = Buffer.concat([
        Buffer.from('0D', 'hex'), // Key: 13
        v13Data                   // Value
    ]);

    // 4. Wrap in MsgProposeVersions: [0, Map]
    // Array(2) + Int(0) + Map
    return Buffer.concat([
        Buffer.from('82', 'hex'), // Array(2)
        Buffer.from('00', 'hex'), // MsgId(0)
        versionMapHeader,
        entryV10,
        entryV13
    ]);
}

// --- Mux Framing ---
function createMuxFrame(protocolId, payload) {
    const header = Buffer.alloc(8);
    const ts = (Date.now() * 1000) & 0xFFFFFFFF;
    header.writeUInt32BE(ts, 0);
    header.writeUInt16BE(protocolId, 4);
    header.writeUInt16BE(payload.length, 6);
    return Buffer.concat([header, payload]);
}

// --- Main Connection Logic ---
const socket = new net.Socket();
let buffer = Buffer.alloc(0);

socket.connect(CONFIG.port, CONFIG.host, () => {
    console.log(`Connected to ${CONFIG.host}:${CONFIG.port}`);
    console.log('>> Sending Handshake (Manual CBOR V10/V13)...');
    
    const payload = buildHandshakePayload();
    socket.write(createMuxFrame(PROTOCOL.HANDSHAKE, payload));
});

socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 8) {
        const protocolId = buffer.readUInt16BE(4);
        const payloadLen = buffer.readUInt16BE(6);

        if (buffer.length < 8 + payloadLen) return; // Wait for full frame

        const payload = buffer.subarray(8, 8 + payloadLen);
        buffer = buffer.subarray(8 + payloadLen);

        try {
            if (protocolId === PROTOCOL.HANDSHAKE) {
                handleHandshake(payload);
            } else if (protocolId === PROTOCOL.CHAIN_SYNC) {
                handleChainSync(payload);
            }
        } catch (err) {
            console.error('Decoding Error:', err);
            socket.destroy();
        }
    }
});

function handleHandshake(payload) {
    // We can safely use the library for decoding (it handles definite/indefinite fine)
    const decoded = cbor.decode(payload);
    const msgId = decoded[0];

    if (msgId === MSG_HANDSHAKE.ACCEPT) {
        console.log(`<< Handshake Accepted! Negotiated Version: ${decoded[1]}`);
        
        console.log('>> Sending ChainSync (FindIntersect)...');
        // MsgFindIntersect: [4, []] -> Array(2) [Int(4), Array(0)]
        // Manual hex: 82 04 80
        const chainSyncPayload = Buffer.from('820480', 'hex');
        socket.write(createMuxFrame(PROTOCOL.CHAIN_SYNC, chainSyncPayload));

    } else if (msgId === MSG_HANDSHAKE.REFUSE) {
        console.error('<< Handshake Refused:', JSON.stringify(decoded[2], null, 2));
        socket.destroy();
    }
}

function handleChainSync(payload) {
    const decoded = cbor.decode(payload);
    const msgId = decoded[0];

    if (msgId === MSG_CHAIN_SYNC.INTERSECT_FOUND || msgId === MSG_CHAIN_SYNC.INTERSECT_NOT_FOUND) {
        // Response format: [MsgId, (Optional Point), Tip]
        // Tip is always the last element
        const tip = decoded[decoded.length - 1];
        const [point, blockNo] = tip;
        const [slot, hash] = point;

        console.log('\n✅ CURRENT CARDANO MAINNET TIP');
        console.log('==============================');
        console.log(`Slot:      ${slot}`);
        console.log(`Block No:  ${blockNo}`);
        console.log(`Hash:      ${hash.toString('hex')}`);
        console.log('==============================\n');
        
        socket.destroy();
    }
}

socket.on('error', (err) => console.error('Socket Error:', err.message));
socket.on('close', () => console.log('Disconnected'));