import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const avatarsDir = path.join(process.cwd(), "public", "avatars");
const files = fs.readdirSync(avatarsDir).filter((f) => f.endsWith(".vrm"));

for (const file of files) {
	const vrmPath = path.join(avatarsDir, file);
	const buf = fs.readFileSync(vrmPath);

	const magic = buf.readUInt32LE(0);
	if (magic !== 0x46546c67) continue;

	const jsonChunkLength = buf.readUInt32LE(12);
	const jsonBuf = buf.slice(20, 20 + jsonChunkLength);

	try {
		const gltf = JSON.parse(jsonBuf.toString("utf-8"));
		let thumbIndex = -1;

		if (gltf.extensions?.VRM?.meta?.texture !== undefined) {
			thumbIndex = gltf.extensions.VRM.meta.texture;
		} else if (gltf.extensions?.VRMC_vrm?.meta?.thumbnailImage !== undefined) {
			thumbIndex = gltf.extensions.VRMC_vrm.meta.thumbnailImage;
		}

		if (thumbIndex !== -1 && gltf.images && gltf.images[thumbIndex]) {
			const imageDef = gltf.images[thumbIndex];
			const bufferViewIndex = imageDef.bufferView;
			if (bufferViewIndex !== undefined && gltf.bufferViews) {
				const bv = gltf.bufferViews[bufferViewIndex];

				const binChunkOffset = 20 + jsonChunkLength;
				const binChunkLength = buf.readUInt32LE(binChunkOffset);
				const binType = buf.readUInt32LE(binChunkOffset + 4);

				if (binType === 0x004e4942) {
					// 'BIN\0'
					const binDataOffset = binChunkOffset + 8;
					const imgData = buf.slice(
						binDataOffset + bv.byteOffset,
						binDataOffset + bv.byteOffset + bv.byteLength,
					);

					const ext = imageDef.mimeType === "image/jpeg" ? ".jpg" : ".png";
					const outPath = path.join(avatarsDir, file.replace(".vrm", ext));
					fs.writeFileSync(outPath, imgData);
					console.log(`Extracted: ${outPath}`);

					const webpPath = outPath.replace(ext, ".webp");
					try {
						// Extract a specific region (simulating a bit wider shot including upper chest)
						// Vrm thumbnails are usually square.
						execSync(`cwebp -q 80 "${outPath}" -o "${webpPath}"`, {
							stdio: "ignore",
						});
						fs.unlinkSync(outPath);
						console.log(`Converted to WebP: ${webpPath}`);
					} catch (e) {
						console.log(`Failed to convert ${outPath} to WebP`);
					}
				}
			}
		} else {
			console.log(`No thumbnail found in ${file}`);
		}
	} catch (e) {
		console.error(`Error parsing JSON in ${file}:`, e.message);
	}
}
