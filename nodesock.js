//TODO: extended payload (but 64bit maybe impossible)
//      continue frames
//      handle more than one frame coming through the tcp socket at once
//      extensions :'(
const http = require('http');
const crypto = require('crypto');
const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\n\r\n';


module.exports = class {
    static createServer(connectListener, httpListener = null) {
        //return a new server object
        return new Server(connectListener, httpListener);
    }


    //connect to a server, create a client object
    //then return it
    static createConnection(options, connectListener = null) {
        const client = new Client();

        if (connectListener != null) {
            client.on('connect', connectListener);
        }

        client.connect(options);

        return client;
    }
}


class Server {
    //the user can optionally give an http listener so that
    //the server can function as an http server as well as 
    //a websocket server
    constructor(connectListener, httpListener) {
        this.events = {'connect': connectListener};

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


    connect(options) {
        const requestOptions = {
            port: options.port,
            hostname: options.hostname,
            headers: {
                'Connection': 'Upgrade',
                'Upgrade': 'websocket',
                'Sec-WebSocket-Key': generateWSKey()
            }
        };
        const req = http.request(requestOptions);

        req.end();

        req.on('upgrade', (res, socket) => {
            prepareClientSocket(socket, this);

            //fire the client's connect event
            fireEvent(this, 'connect');
        });
    }


    on(eventName, callback) {
        this.events[eventName] = callback;
    }


    write(data) {
        const frame = constructFrame(1, data);

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
        receiveFrames(client, bytes);
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


//receive the bytes, parse them as a message 
//and send that to the handler
//TODO: bytes could possibly contain more than one frame
function receiveFrames(client, bytes) {
    const msg = parseFrame(bytes);

    handleFrame(client, msg);
}


function handleFrame(client, msg) {
    switch (msg.opcode) {
        case 0x0: //continuation frame
            break;

        case 0x1: //text frame
        case 0x2: //binary frame
            //at some point will need to check for continue frames here
            fireEvent(client, 'data', msg.payload);
            break;

        case 0x8: //connection close
            let statusCode = 0;
            let reason = "no reason given";

            if (msg.payload) {
                statusCode = msg.payload.readUInt16BE(0);

                if (msg.payload.length > 2) {
                    reason = msg.payload.split(2, msg.payload.length - 2)
                                          .toString('utf8');
                }
            }

            fireEvent(client, 'end', {statusCode, reason});

            client.socket.end(constructCloseMessage(0, "received close message"));
            break;

        case 0x9: //ping
            client.socket.write(constructPongMessage(msg.payload));
            break;

        case 0xA: //pong
            //pong frames may arrive unsolicited, this serves as a heartbeat
            //and no response is expected
            break;

        default:
            throw {msg: 'unhandled opcode'};
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


function constructPingMessage(applicationData = []) {
    return constructFrame(9, applicationData);
}


function constructPongMessage(applicationData = []) {
    return constructFrame(0xA, applicationData);
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
    frame[1] |= mask << 7;
    
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
        throw {msg: 'payload too long, need cont. frames but NYI'};
    }

    bytesWritten += 2;

    if (mask == 1) {
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
    const fin        = (bytes[0] & 0b10000000) >> 7;
    const rsv1       = (bytes[0] & 0b01000000) >> 6;
    const rsv2       = (bytes[0] & 0b00100000) >> 5;
    const rsv3       = (bytes[0] & 0b00010000) >> 4;
    const opcode     =  bytes[0] & 0b00001111;
    const mask       = (bytes[1] & 0b10000000) >> 7;
    const payloadLen =  bytes[1] & 0b01111111;

    //read data of dynamic location
    let extendedPayloadLen;

    //this counts the number of bytes read
    //from the end of the fixed section
    let bytesRead = 0;

    //extendedPayload size = 16/64 if payloadLen = 126/127
    if (payloadLen == 126) {
        bytesRead = 2;
    }
    else if (payloadLen == 127) {
        bytesRead = 8;
    }
    
    //just use offsetBytes to find the end here
    //as it's the first dynamic section
    if (payloadLen >= 126) {
        extendedPayloadLen = bytes.slice(2, 2 + bytesRead);
    }

    let maskingKey = null;
    bytesRead += 2;
    
    if (mask == 1) {
        maskingKey = bytes.slice(bytesRead, bytesRead + 4);
        bytesRead += 4;
    }

    //read the payload using either extended or standard length
    let payload;
    if (extendedPayloadLen != null) {
        throw {msg: 'NYI: Extended payload length'};
    }
    else {
        payload = bytes.slice(bytesRead, bytesRead + payloadLen);
    }
    
    //unmask the payload bytes if necessary
    if (mask == 1) {
        payload = applyMask(payload, maskingKey);
    }

    //create the message object and return it
    return {fin, rsv1, rsv2, rsv3, opcode, payload};
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
        a[i] = bytes[i] ^ key[i % 4];
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


//generate an array of 4 random bytes
function randomBytes(numBytes) {
    const key = [];

    for (let i = 0; i < numBytes; ++i) {
        key[i] = Math.random() * 255;
    }

    return key;
}