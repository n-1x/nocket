//Author: Nicholas J D Dean
//Date created: 2017-12-07

const tls = require('tls');
const { URL } = require('url'); //TODO: FIX THIS
const BitStream = require('./BitStream');

module.exports = class wss {
    constructor(serverURL) {
        if (serverURL) {
            this.connect(serverURL);
        }

        this.protocolSwitched = false;
        this.callbacks = {};
    }



    //allow the registering of events
    on(eventString, callback) {
        this.callbacks[eventString] = callback;
    }



    //check if an event has been registered, and
    //send it if it has
    propagateEvent(eventString, params) {
        if (this.callbacks[eventString]) {
            if (params) {
                this.callbacks[eventString](params);
            } else {
                this.callbacks[eventString]();
            }
        }
    }


    
    //create a connection with the endpoint and attempt
    //to switch the protocol to a websocket one
    connect(endpointURL) {
        const theURL = new URL(endpointURL);
    
        //the discord documentation reccomends that
        //these are explicitly stated and included in
        //the request. Though I'm not 100% sure where
        //they go.
        theURL.searchParams.append('v', '6');
        theURL.searchParams.append('encoding', 'json');
    
        const options = {
            port: 443,
            host: theURL.host
        }
            
        const sock = tls.connect(options, () => {

            const key = generateWebSocketKey();
    
            const headers = `GET / HTTP/1.1\r\n` +
                            `Host: ${theURL.host}\r\n` +
                            'Upgrade: websocket\r\n' +
                            'Connection: Upgrade\r\n' +
                            `Sec-WebSocket-Key: ${key}\r\n` +
                            'Sec-WebSocket-Version: 13\r\n' + 
                            `${theURL.search}\r\n\r\n`;
    
            sock.write(headers);
        });

        sock.on('data', (data) => {
            if (!this.protocolSwitched) {
                this.protocolSwitched = true;
                
                //now that the protocol is switched
                //the websocket can now be considered
                //connected
                this.propagateEvent('connected');
            } else {
                let frames = parseData(data);

                //call the data function for all frames that
                //were contained within the data fetched from
                //the socket.
                for(let i = 0; i < frames.length; ++i) {
                    this.propagateEvent('data', frames[i]);
                }
            }
        });

        sock.on('end', () => {
            if (this.callbacks['end']) {
                this.callbacks['end']();
            }
        });

        this.socket = sock;
    }



    //expects a javascript object
    //serialises the object as json and sends
    //it through the websocket in a valid data frame.
    write(data, opcode=1) {
        let df = buildWSFrame(opcode, data);

        this.socket.write(df.toBuffer());
    }
}



//generate 16 random bytes and encode them
//in base64.
function generateWebSocketKey() {
    let theArray = [];

    for(let i = 0; i < 16; ++i) {
        theArray[i] = Math.floor(Math.random() * 256);
    }

    return Buffer.from(theArray).toString('base64');
}



//return a stream containing the bytes of a 
//valid websocket data frame. Because every message
//from client to server must be masked, this function
//always masks the data
function buildWSFrame(opcode, data) {
    const payloadBits = new BitStream();
    const maskingKey = 0x12345678;
    const dataFrame = new BitStream();

    payloadBits.addString(JSON.stringify(data));
    
    dataFrame.addBits(1, 1);      //fin
    dataFrame.addBits(0, 3);      //rsv 
    dataFrame.addBits(opcode, 4); //opcode
    dataFrame.addBits(1, 1);      //masked
    
    //add the correctly formatted payload length
    let numBitsForPayloadLength = 7;
    let payloadNumBytes = payloadBits.numBytes();
    
    if (payloadNumBytes > 65535) {
        dataFrame.addBits(127, 7);
        
        numBitsForPayloadLength = 64;
    } else if (payloadNumBytes > 127) {
        dataFrame.addBits(126, 7);
        
        numBitsForPayloadLength = 16;
    }
    dataFrame.addBits(payloadNumBytes, numBitsForPayloadLength);
    
    //add 4 bytes for the masking key
    dataFrame.addBits(maskingKey, 32);
    
    //apply the mask and add the payload
    payloadBits.xor(maskingKey, 32);

    dataFrame.append(payloadBits);
    return dataFrame;
}



//Because more than one data frame can be received from
//the tls, this function extracts all the data frames and
//returns them in an array.
function parseData(data) {
    let stream = new BitStream();
    let frames = [];

    stream.fromBuffer(data);
    let binary = stream.binary;

    while(binary.length > 0) {
        const obj = parseDataFrame(binary);
        frames.push(obj.frame);
        binary = obj.remainingData;
    }

    return frames;
}



//Receives a binary string. This string may contain
//more than one data frame. This function will read a single
//frame, then return it in an object along with all the remaining
//binary data.
//The idea is that you loop this until it returns no remaining data.
function parseDataFrame(binString) {
    let frame = {};

    //current bit is the position in the binary string
    //up to which data has been read. This is used beacuse
    //some parts are of variable size.
    let currentBit = 0;
    let payloadLength = 0;
    
    frame.fin = binString[0] == '1';
    frame.rsv = binString.substr(1, 3);
    frame.opcode = parseInt(binString.substr(4, 4), 2);
    frame.masked = binString[8] == '1';

    //because of the way the websocket protocol works,
    //this may not be the actual length of the payload length.
    //The actual length will be stored either in here or in
    //extendedPayloadLength. Read the spec for more info.
    frame.payloadLen = parseInt(binString.substr(9, 7), 2);

    //all bits have been guaranteed until now, so
    //just set currentBit here.
    currentBit = 16;

    //determine if more bits should be read to
    //get an extended payload length, or if the
    //normal 7 bits were enough.
    payloadLength = frame.payloadLen;
    let bitsToRead = 0;

    if (frame.payloadLen == 126) {
        bitsToRead = 16;
    } else if (frame.payloadLen == 127) {
        bitsToRead = 64;
    }

    if (bitsToRead > 0) {
        let lengthString = binString.substr(currentBit, bitsToRead);

        frame.extendedPayloadLength = parseInt(lengthString, 2);
        currentBit += bitsToRead;

        payloadLength = frame.extendedPayloadLength;
    }

    //if the frame is masked, interpret the masking
    //key, then interpret the payload
    if (frame.masked) {
        //next 32 bits are the masking key
        frame.maskingKey = parseInt(binString.substr(currentBit, 32), 2);
        currentBit += 32;
    } 

    //read the payload <actualPayloadLength> more bits.
    let payloadBinString = binString.substr(currentBit, payloadLength * 8);
    let payload = new BitStream();

    payload.binary += payloadBinString;
    frame.payload = payload.toBuffer().toString();

    currentBit += payloadLength * 8;

    return {
        frame: frame,
        remainingData: binString.substr(currentBit, binString.length - currentBit)
    };
}