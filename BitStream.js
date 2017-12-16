//Author: Nicholas J D Dean
//Date: 2017-12-14

//Used to build streams of bits at a bit level.
//You can add a number and choose how many bits
//that number should occupy in the stream.
//E.g addBits(1, 8) means that the first 8 bits
//of the stream will be 0b00000001. Then if you 
//addBits(0b101, 4), the stream will be
//000000010101.
class BitStream {
    constructor() {
        this.binary = '';
    }



    //add some bits to the string. The length
    //must be provided so leading zeroes can
    //be added.
    addBits(data, length) {
        let string = data.toString(2);

        while(string.length < length) {
            string = '0' + string;
        }

        this.binary += string;
    }



    //add the UTF-8 encoding of a string
    addString(string) {
        for (let i = 0; i < string.length; ++i) {
            const charCode = encodeUTF8(string.charCodeAt(i));
            this.addBits(charCode, requiredBytes(charCode) * 8);
        }
    }



    //append another stream to the end of this one
    append(otherBitStream) {
        this.binary += otherBitStream.binary;
    }



    //return the number of bytes required to store
    //all the bits in the stream
    numBytes() {
        return Math.ceil(this.binary.length / 8);
    }



    //xor the entire binary string with the given
    //key. The length of the key must be provided
    //so leading zeroes are used.
    xor(key, keyBitLength) {
        const keyStream = new BitStream();
        keyStream.addBits(key, keyBitLength);
        
        const keyLength = keyStream.binary.length;
        const str = this.binary;
        const charXOR = (a, b) => {
            if (a === b) {
                return '0';
            } else {
                return '1';
            }
        };
        let newString = '';

        for (let i = 0; i < this.binary.length; ++i) {
            newString += charXOR(str[i], keyStream.binary[i % keyLength]);
        }

        this.binary = newString;
    }



    //convert a binary string to a buffer. The length of
    //the string must be a multiple of 8 otherwise this will break
    toBuffer() {
        let array = [];
        
        //chunk the string into bytes, parse them as ints into an
        //array. Put the array into a buffer and read it as a string
        for (let i = 0; i < this.binary.length; i += 8) {
            array[Math.floor((i+1) / 8)] = parseInt(this.binary.substr(i, 8), 2);
        }
        
        return Buffer.from(array);
    }



    //convert a buffer to a binary string and set that string
    //to be the contents of this stream
    fromBuffer(b) {
        let s = '';

        for(let i = 0; i < b.length; ++i) {
            let val = b[i].toString(2);
            
            while (val.length < 8) {
                val = '0' + val;
            }
            
            s += val;
        }

        this.binary = s;
    }
}
module.exports = BitStream;



//returns the number of bytes required
//to represent the given number
function requiredBytes(num) {
    let numBits = 0;
    
    while (Math.pow(2, numBits) - 1 < num) {
        ++numBits;
    }

    return Math.ceil(numBits / 8);
}



//Takes a UTF code point and encodes it
//in UTF-8. DOES NOT take encoded data, only
//the code point. You must first remove the
//encoding bits before passing to this function.
function encodeUTF8(codepoint) {
    const codeStream = new BitStream();
    const u8Stream = new BitStream();
    
    codeStream.addBits(codepoint, requiredBytes(codepoint) * 8);

    //num bytes is the number of bytes that the
    //UTF-8 string will use.
    let numBytes = 1;
    let remBits = 8;

    //Set the number of bytes required based on the 
    //value of the codepoint. Values taken from Wikipedia.
    if (codepoint > 0xffff) {
        numBytes = 4;
    } else if (codepoint > 0x7ff) {
        numBytes = 3;
    } else if (codepoint > 0x7f) {
        numBytes = 2;
    }

    //add the encoding bits to the first byte.
    //First bytes start with numBytes number of
    //1s then a zero. Unless numBytes is 1, then
    //it's just a zero.
    if (numBytes > 1) {
        //the remaining bits in the byte reduces
        //because of the encoding bits. numBytes
        //1s followed by 1 zero = numbytes + 1 used
        //up.
        remBits = 8 - (numBytes + 1)

        for (let i = 0; i < numBytes; ++i) {
            u8Stream.addBits(1, 1);
        }
    }

    //add the zero
    u8Stream.addBits(0, 1);

    //the current bit of the code point
    //that is being added to the final 
    //string
    let currentBit = 0;

    //the binary string of the code point
    const string = codeStream.binary;

    for (let remBytes = numBytes; remBytes > 0; --remBytes) {
        const fill = string.substr(currentBit, remBits)
        
        //fill the current utf8 byte
        u8Stream.addBits(parseInt(fill, 2), remBits);    

        //add the start of the next byte, all following
        //bytes in utf8 start with 0b01
        if (remBytes > 1) {
            u8Stream.addBits(0b10, 2);
            currentBit += remBits;
            remBits = 6;
        }
    }

    return parseInt(u8Stream.binary, 2);
}