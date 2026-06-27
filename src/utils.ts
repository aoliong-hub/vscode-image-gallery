import path from 'path';
import vscode from 'vscode';
import crypto from 'crypto';
import fileSystem from 'fs';
import sharp from 'sharp';
import { TFolder } from 'custom_typings';

export let packageJSON: any; // global variable
export function readPackageJSON(context: vscode.ExtensionContext) {
	packageJSON = context.extension.packageJSON;
}

export function getCwd() {
	if (!vscode.workspace.workspaceFolders) {
		let message = "Image Gallery: Working folder not found, open a folder and try again";
		vscode.window.showErrorMessage(message);
		return '';
	}
	const cwd = vscode.workspace.workspaceFolders[0].uri.path;
	return cwd;
}

function getNonce() {
	let text = 'N';
	const possible = '0123456789ABCDEF';
	for (let i = 0; i < 16; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
export const nonce = getNonce();

function getImageExtensions() {
	const pattern = packageJSON.contributes.customEditors[0].selector[0].filenamePattern;
	const regex = /(?<=\{)(.*?)(?=\})/g;
	const match = pattern.match(regex)[0];
	const imageExtensions: string[] = match.split(',');
	return imageExtensions;
}

export function getGlob() {
	const imgExtensions = getImageExtensions();
	const upperCaseImg = imgExtensions.map(ext => ext.toUpperCase());
	const globPattern = `**/*.{${[...imgExtensions, ...upperCaseImg].join(',')}}`;
	return globPattern;
}

export function getFilename(imgPath: string) {
	const filename = decodeURI(imgPath).split("/").pop();
	if (filename) {
		return filename.split("?").shift();
	}
	return filename;
}

export function hash256(str: string, truncate = 16) {
	return 'H' + crypto.createHash('sha256').update(str).digest('hex').substring(0, truncate);
}

export async function asyncPool<T, R>(concurrency: number, items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	const executing = new Set<Promise<void>>();
	for (const item of items) {
		const p = fn(item).then(r => { results.push(r); });
		executing.add(p);
		p.then(() => executing.delete(p));
		if (executing.size >= concurrency) {
			await Promise.race(executing);
		}
	}
	await Promise.all(executing);
	return results;
}

export async function getFileStats(imgUris: vscode.Uri[]): Promise<Record<string, any>> {
	const result = await asyncPool(50, imgUris, async (imgUri) => {
		const p = imgUri.fsPath;
		const stat = await fileSystem.promises.stat(p);
		return [p, stat] as const;
	});

	return Object.fromEntries(result);
}

export async function getFolders(imgUris: vscode.Uri[], action: "create" | "change" | "delete" = "create") {
	let folders: Record<string, TFolder> = {};

	let fileStats;
	if (action !== "delete") {
		fileStats = await getFileStats(imgUris);
	}
	for (const imgUri of imgUris) {
		const folderPath = path.dirname(imgUri.path);
		const folderId = hash256(folderPath);

		if (!folders[folderId]) { // first image of the folder
			folders[folderId] = {
				id: folderId,
				path: folderPath,
				images: {},
			};
		}

		if (action !== 'delete' && fileStats !== undefined) {
			const fileStat = fileStats[imgUri.fsPath as keyof typeof fileStats];
			const dotIndex = imgUri.fsPath.lastIndexOf('.');
			const imageId = hash256(imgUri.path);
			folders[folderId].images[imageId] = {
				id: imageId,
				uri: imgUri,
				ext: imgUri.fsPath.slice(dotIndex + 1).toUpperCase(),
				size: fileStat['size'],
				mtime: fileStat['mtime'],
				ctime: fileStat['ctime'],
				status: "",
			};
		}
	}
	return folders;
}

export function getImageSizeStat(folders: Record<string, TFolder>) {
	const sizes: number[] = [];
	for (const folderId in folders) {
		for (const imageId in folders[folderId].images) {
			sizes.push(folders[folderId].images[imageId].size);
		}
	}
	const count = sizes.length;
	const sum = (a: number, b: number) => a + b;
	const mean = (count > 0) ? sizes.reduce(sum, 0) / count : 0;
	const std = (count > 1) ? Math.sqrt(sizes.map(x => Math.pow(x - mean, 2)).reduce(sum, 0) / count) : 0;

	return {
		count,
		mean: Math.round(mean),
		std: Math.round(std),
	};
}

const thumbnailCache = new Map<string, string>();

export async function generateThumbnail(fsPath: string, width = 200, quality = 60): Promise<string> {
	const cached = thumbnailCache.get(fsPath);
	if (cached) { return cached; }

	try {
		const buffer = await sharp(fsPath)
			.resize(width, undefined, { fit: 'inside', withoutEnlargement: true })
			.jpeg({ quality, mozjpeg: true })
			.toBuffer();
		const dataUri = 'data:image/jpeg;base64,' + buffer.toString('base64');
		thumbnailCache.set(fsPath, dataUri);
		return dataUri;
	} catch {
		return '';
	}
}

export async function generateThumbnails(
	folders: Record<string, TFolder>,
	concurrency = 20,
): Promise<Record<string, string>> {
	const items: Array<{imageId: string, fsPath: string}> = [];
	for (const folder of Object.values(folders)) {
		for (const image of Object.values(folder.images)) {
			items.push({ imageId: image.id, fsPath: image.uri.fsPath });
		}
	}

	const result: Record<string, string> = {};
	await asyncPool(concurrency, items, async (item) => {
		const dataUri = await generateThumbnail(item.fsPath);
		if (dataUri) { result[item.imageId] = dataUri; }
		return dataUri;
	});
	return result;
}