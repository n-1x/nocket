//Author: Nicholas J D Dean
//Date created: 2017-12-07

var tls = require('tls');
var { URL } = require('url'); //TODO: FIX THIS

module.exports = class wss {
    constructor(serverURL) {
        if (serverURL) {
            this.connect(serverURL);
        }

        this.protocolSwitched = false;
        this.callbacks = {};
    }



    on(eventString, callback) {
        this.callbacks[eventString] = callback;
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
                
                if (this.callbacks['connected']) {
                    this.callbacks['connected']();
                }
            } else if (this.callbacks['data']) {
                let frames = parseData(data);

                //call the data function for all frames that
                //were contained within the data fetched from
                //the socket.
                for(let i = 0; i < frames.length; ++i) {
                    this.callbacks['data'](frames[i]);
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
        this.socket.write(buildDataFrame(opcode, data));
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



//convert a binary string to a buffer. The length of
//the string must be a multiple of 8 otherwise this will break
function binStringToBuffer(s) {
    let array = [];
    
    //chunk the string into bytes, parse them as ints into an
    //array. Put the array into a buffer and read it as a string
    for (let i = 0; i < s.length; i += 8) {
        array[Math.floor((i+1) / 8)] = parseInt(s.substr(i, 8), 2);
    }
    
    return Buffer.from(array);
}



//convert a buffer to a binary string
function bufferToBinString(b) {
    let s = '';

    for(let i = 0; i < b.length; ++i) {
        let val = b[i].toString(2);

        while (val.length < 8) {
            val = '0' + val;
        }

        s += val;
    }

    return s;
}



//apply the 4 byte mask to the buffer. Because of the
//nature of XOR this can mask and unmask
function applyMask(buffer, maskingKey) {
    let newBuffer = [];    

    for(let i = 0; i < buffer.length; ++i) {
        newBuffer[i] = buffer[i] ^ maskingKey[i % 4];
    }

    return Buffer.from(newBuffer);
}



//return a buffer containing the bytes of a 
//valid websocket data frame. Because every message
//from client to server must be masked, this function
//always masks the data
function buildDataFrame(opcode, data) {
    let dataFrame = '';
    let payloadBuffer = Buffer.from(JSON.stringify(data));
    const maskingKey = Buffer.from([12, 34, 56, 78]);

    dataFrame += '1';   //fin
    dataFrame += '000'; //rsv

    let opcodeString = opcode.toString(2);

    while(opcodeString.length < 4) {
        opcodeString = '0' + opcodeString;
    }

    dataFrame += opcodeString;
    dataFrame += '1'    //masked

    //write payload length 
    const payloadLength = payloadBuffer.length;
    let numBitsForPayloadLength = 7

    //if the payload length needs more than 16 bits
    if (payloadLength > Math.pow(2, 16) - 1) {
        dataFrame += '1111111';

        numBitsForPayloadLength = 64;
    } else if (payloadLength > Math.pow(2, 7) - 1) {
        dataFrame += '1111110';

        numBitsForPayloadLength = 16;
    }

    let payloadLengthString = payloadBuffer.length.toString(2);
    
    //add leading zeroes, this needs to occupy 7 bits
    while(payloadLengthString.length < numBitsForPayloadLength) {
        payloadLengthString = '0' + payloadLengthString;
    }
    
    //add the payload length to the string
    dataFrame += payloadLengthString;
    
    //add the masking key to the string
    dataFrame += bufferToBinString(maskingKey);

    //mask the payload
    let maskedPayload = applyMask(payloadBuffer, maskingKey);

    //add the masked payload to the string
    dataFrame += bufferToBinString(maskedPayload);

    return binStringToBuffer(dataFrame);
}



//Because more than one data frame can be received from
//the tls, this function extracts all the data frames and
//returns them in an array.
function parseData(data) {
    let frames = [];

    let binary = bufferToBinString(data)

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
        frame.maskingKey = binStringToBuffer(binString.substr(currentBit, 32));
        currentBit += 32;
    } 

    //read the payload <actualPayloadLength> more bits.
    let payloadBinString = binString.substr(currentBit, payloadLength * 8);
    frame.payload = binStringToBuffer(payloadBinString).toString();
    currentBit += payloadLength * 8;

    return {
        frame: frame,
        remainingData: binString.substr(currentBit, binString.length - currentBit)
    };
}