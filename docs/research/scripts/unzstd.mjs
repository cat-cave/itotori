import { createReadStream, createWriteStream } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { pipeline } from "node:stream/promises";
await pipeline(createReadStream("db.tar.zst"), createZstdDecompress(), createWriteStream("db.tar"));
console.log("done");
