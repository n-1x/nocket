//TODO: extended payload (but 64bit maybe impossible)
//      continue frames
//      handle more than one frame coming through the tcp socket at once
//      extensions :'(
const http = require('https');
const crypto = require('crypto');
const URL = require('url');
const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\n\r\n';


module.exports = class {
    static createServer(connectListener, httpListener = null) {
        //return a new server object
        return new Server(connectListener, httpListener);
    }


    //connect to a server, create a client object
    //then return it
    static createConnection(url, connectListener = null) {
        const client = new Client();

        if (connectListener != null) {
            client.on('connect', connectListener);
        }

        client.connect(URL.parse(url));

        return client;
    }
}


class Server {
    //the user can optionally give an http listener so that
    //the server can function as an http server as well as 
    //a websocket server
    constructor(connectListener, httpListener) {
        this.events = { 'connect': connectListener };
        this.buffer = [];

        //bind the custom http listener
        if (httpListener != null) {
            this.server = http.createServer(httpListener);
        }
        else {
            this.server = http.createServer((req, res) => {
                res.statusCode = 400;
                res.end(BAD_REQUEST);
            });
        }

        //handle the http upgrade request
        this.server.on('upgrade', (req, socket) => {
            const wsKey = req.headers['sec-websocket-key'];

            //only allow the upgrade if a key was presend
            //can add more checks in the future for the correct
            //headers
            if (wsKey) {
                const acceptKey = generateAcceptKey(wsKey);

                socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                    'Upgrade: WebSocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);

                const client = new Client();
                prepareClientSocket(socket, client);

                //fire the server's connect event
                fireEvent(this, 'connect', client);
            }
            else {
                socket.end(BAD_REQUEST);
            }
        });

        this.server.on('clientError', (err, socket) => {
            socket.end(BAD_REQUEST);
        });
    }


    on(eventName, callback) {
        this.events[eventName] = callback;
    }


    listen(port, callback) {
        this.server.listen(port, callback);
    }
}


class Client {
    constructor() {
        this.socket = null;
        this.events = {};
    }


    connect(url) {
        const requestOptions = {
            hostname: url.host,
            headers: {
                'Connection': 'Upgrade',
                'Upgrade': 'websocket',
                'Sec-WebSocket-Key': generateWSKey(),
                'Sec-WebSocket-Version': '13',
            }
        };

        const req = http.request(requestOptions);

        req.on('upgrade', (res, socket, upgradeHead) => {
            prepareClientSocket(socket, this);

            //fire the client's connect event
            fireEvent(this, 'connect');
        });

        req.on('error', err => {
            console.error("Error connecting to server: " + err);
        });

        req.end();
    }


    on(eventName, callback) {
        this.events[eventName] = callback;
    }


    write(data) {
        const frame = constructFrame(1, data);

        this.socket.write(frame);
    }

    
    ping(data) {
        const frame = constructFrame(9, data);

        this.socket.write(frame);
    }


    //close the connection
    end(data = null) {
        if (data != null) {
            this.write(data);
        }
        this.socket.end(constructCloseMessage(1, message));
    }
}


//prepare the client socket to be ready for use as a web socket
//once this function is completed
function prepareClientSocket(socket, client) {
    //when any socket receives data, process it as websocket
    //data, which will call the data event on the client
    //with the parsed data
    socket.on('data', bytes => {
        receiveFrame(client, bytes);
    });

    //if the socket encounters an error, throw it through
    socket.on('error', err => {
        //mimic the behaviour of the standard error event;
        //if no handler has been registered, throw it
        if (client.events['error']) {
            fireEvent(client, 'error', err);
        }
        else {
            throw err;
        }
    });

    client.socket = socket
}

//receives a complete frame and concatenates if receiving continuation frames
// function receiveMessage(client, frame) {
//     if (client.inProgressOpcode) {
//         if (msg.opcode === 0) {
//         }
//         client.buffer = Buffer.concat([client.buffer, bytes]);
//     }
//     else {
//         client.buffer = msg.payload;
//         client.inProgressOpcode = msg.opcode;
//     }

//     if (msg.fin) {
//         handleMessage(client, client.inProgressOpcode, client.buffer.toString());
//         client.buffer = null;
//         client.inProgressOpcode = null;
//     }
// }


//receive the bytes, parse them as a message 
//and send that to the handler
//TODO: bytes could possibly contain more than one frame
function receiveFrame(client, bytes) {
    if (client.currentFrame) { //frame in progress
        client.currentFrame.payload = Buffer.concat([client.currentFrame.payload, bytes]);
        client.currentFrame.remainingToRead -= bytes.length;

        if (client.currentFrame.remainingToRead < 0) {
            throw { msg: "TODO: read too far after a frame end, slice the bytes when concating" };
        }
        else if (client.currentFrame.remainingToRead === 0) {
            handleMessage(client, client.currentFrame.opcode, client.currentFrame.payload);
            delete client.currentFrame;
        }
    }
    else { //new frame
        const msg = parseFrame(bytes);

        if (msg.remainingToRead) {
            client.currentFrame = msg;
        }
        else {
            handleMessage(client, msg.opcode, msg.payload);
        }
    }
}


function handleMessage(client, opcode, payload) {
    switch (opcode) {
        case 0x1: //text frame
        case 0x2: //binary frame
            //at some point will need to check for continue frames here
            fireEvent(client, 'data', payload);
            break;

        case 0x8: //connection close
            let statusCode = 0;
            let reason = "no reason given";

            if (payload) {
                statusCode = payload.readUInt16BE(0);

                if (payload.length > 2) {
                    reason = payload.split(2, payload.length - 2)
                        .toString('utf8');
                }
            }

            fireEvent(client, 'end', { statusCode, reason });
            client.socket.end(constructCloseMessage(0, "received close message"));
            break;

        case 0x9: //ping
            const pongFrame = constructFrame(0xA, payload);
            client.socket.write(pongFrame);
            break;

        case 0xA: //pong
            fireEvent(client, 'pong', payload);
            break;

        default:
            console.error("Hit unhandled opcode " + opcode);
            console.error("with payload\n--------------\n" + payload.toString());
            console.error("-----------");
    }
}


//build a websocket message for closing the connection
function constructCloseMessage(statusCode = null, reason = null) {
    let payload = [];

    if (statusCode != null) {
        let text = "";

        if (reason != null) {
            text = reason;
        }

        const buf = Buffer.alloc(2 + text.length);

        buf.writeInt16BE(statusCode);
        buf.write(text, 'utf8');

        payload = buf;
    }

    return constructFrame(8, payload);
}


function constructFrame(opcode, payload, mask = true) {
    const frame = [];
    let bytesWritten = 0;
    //creates a copy of the payload if it's already a buffer
    //or will convert the payload to a buffer if it's a different type
    let payloadBytes = Buffer.from(payload);

    frame[0] = 0;

    //FOR NOW: hard code fin and rsv
    frame[0] |= 1 << 7; //fin
    frame[0] |= 0 << 6; //rsv1
    frame[0] |= 0 << 5; //rsv2
    frame[0] |= 0 << 4; //rsv3
    frame[0] |= opcode;

    frame[1] = 0;
    frame[1] |= mask ? (1 << 7) : 0;

    if (payload.length < 126) {
        frame[1] |= payload.length;
    }
    else if (payload.length < 65535) {
        frame[1] |= 126;
        bytesWritten += 2;

        //write the extended payload length
        frame[2] = (payload.length & 0xff00) >> 8;
        frame[3] = (payload.length & 0xff);
    }
    else {
        throw { msg: 'payload too long, need cont. frames but NYI' };
    }

    bytesWritten += 2;

    if (mask) {
        //generate the masking key, just 4 random bytes
        const key = randomBytes(4);

        //write the masking key to the frame
        for (let i = 0; i < 4; ++i) {
            frame[bytesWritten + i] = key[i];
        }

        bytesWritten += 4;

        //mask the payload bytes
        payloadBytes = applyMask(payloadBytes, key);
    }

    //write the payload data
    for (let i = 0; i < payloadBytes.length; ++i) {
        frame[bytesWritten + i] = payloadBytes[i];
    }

    return Buffer.from(frame);
}


//parse the frame data and send it to the handler
function parseFrame(bytes) {
    //read all fixed data
    const fin = (bytes[0] & 0b10000000) >> 7;
    const rsv1 = (bytes[0] & 0b01000000) >> 6;
    const rsv2 = (bytes[0] & 0b00100000) >> 5;
    const rsv3 = (bytes[0] & 0b00010000) >> 4;
    const opcode = bytes[0] & 0b00001111;
    const mask = (bytes[1] & 0b10000000) >> 7;
    let payloadLen = bytes[1] & 0b01111111;

    let extendedPayloadSize = 0; //size of extended payload section in bytes
    let bytesRead = 2;

    //extendedPayload size = 2/8 bytes if payloadLen = 126/127
    if (payloadLen === 126) {
        extendedPayloadSize = 2;
        payloadLen = bytes.readUInt16BE(bytesRead,
            bytesRead + extendedPayloadSize);
    }
    else if (payloadLen === 127) {
        extendedPayloadSize = 8;
        payloadLen = Number(bytes.readBigUInt64BE(bytesRead,
            bytesRead + extendedPayloadSize));
    }

    bytesRead += extendedPayloadSize;
    let maskingKey = null;

    if (mask === 1) {
        maskingKey = bytes.slice(bytesRead, bytesRead + 4);
        bytesRead += 4n;
    }

    //read the payload using either extended or standard length
    const payloadEndByte = bytesRead + Number(payloadLen);
    const payload = bytes.slice(bytesRead, payloadEndByte);
    let remainingToRead = null;

    if (payloadEndByte > bytes.length) {
        remainingToRead = payloadEndByte - bytes.length;
    }

    //unmask the payload bytes if necessary
    if (mask === 1) {
        payload = applyMask(payload, maskingKey);
    }

    //create the message object and return it
    return { fin, rsv1, rsv2, rsv3, opcode, payload, payloadLen, remainingToRead };
}


//fire an event if it is registered.
//should be bound to the object whose event
//will be fired
function fireEvent(object, eventName, ...args) {
    const callback = object.events[eventName];

    if (callback) {
        callback(...args);
    }
}


//xor bytes with the 4 byte key
//can be used to mask or unmask
function applyMask(bytes, key) {
    const a = [];

    bytes.forEach((byte, i) => {
        a[i] = byte ^ key[i % 4];
    });

    return Buffer.from(a);
}


//generate the server's response key.
//append the GUID to the websocket key, then return
//the sha1 of that string encoded in base64
function generateAcceptKey(wsKey) {
    //the GUID defined in RFC 6455
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const hash = crypto.createHash('sha1').update(wsKey + GUID);

    return hash.digest('base64');
}


//a websocket key is 16 random bytes encoded in base64
function generateWSKey() {
    return Buffer.from(randomBytes(16)).toString('base64');
}


//generate an array of n random bytes
function randomBytes(numBytes) {
    const key = [];

    for (let i = 0; i < numBytes; ++i) {
        key[i] = Math.floor(Math.random() * 256);
    }

    return key;
}