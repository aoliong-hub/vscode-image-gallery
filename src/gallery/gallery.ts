import * as vscode from 'vscode';
import * as utils from '../utils';
import { TFolder } from 'custom_typings';
import CustomSorter from './sorter';
import HTMLProvider from '../html_provider';
import { reporter } from '../telemetry';

export let disposable: vscode.Disposable;

export function activate(context: vscode.ExtensionContext) {
	const gallery = new GalleryWebview(context);
	disposable = vscode.commands.registerCommand('gryc.openGallery',
		async (galleryFolder?: vscode.Uri) => {
			const panel = await gallery.createPanel(galleryFolder);
			panel.webview.onDidReceiveMessage(
				message => gallery.messageListener(message, panel.webview),
				undefined,
				context.subscriptions,
			);

			const fileWatcher = gallery.createFileWatcher(panel.webview, galleryFolder);
			context.subscriptions.push(fileWatcher);
			panel.onDidDispose(
				() => fileWatcher.dispose(),
				undefined,
				context.subscriptions,
			);
	});
	context.subscriptions.push(disposable);
	reporter.sendTelemetryEvent('gallery.activate');
}

export function deactivate() {
	if (!disposable) { return; }
	disposable.dispose();
	reporter.sendTelemetryEvent('gallery.deactivate');
}

class GalleryWebview {
	private gFolders: Record<string, TFolder> = {};
	private customSorter: CustomSorter = new CustomSorter();
	private galleryFolder?: vscode.Uri;
	private deltaBuffer: Array<{type: string, uri: vscode.Uri}> = [];
	private deltaTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly deltaDebounceMs = 300;
	private readonly deltaBatchThreshold = 50;

	constructor(private readonly context: vscode.ExtensionContext) { }

	private async getImageUris(galleryFolder?: vscode.Uri | string) {
		/**
		 * Recursively get the URIs of all the images within the folder.
		 * 
		 * @param galleryFolder The folder to search. If not provided, the
		 * workspace folder will be used.
		 */
		let globPattern = utils.getGlob();
		let imgUris = await vscode.workspace.findFiles(
			galleryFolder ? new vscode.RelativePattern(galleryFolder, globPattern) : globPattern
		);
		return imgUris;
	}

	public async createPanel(galleryFolder?: vscode.Uri) {
		this.galleryFolder = galleryFolder;
		const startTime = Date.now();
		vscode.commands.executeCommand('setContext', 'ext.viewType', 'gryc.gallery');
		const panel = vscode.window.createWebviewPanel(
			'gryc.gallery',
			`Image Gallery${galleryFolder ? ': ' + utils.getFilename(galleryFolder.path) : ''}`,
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		const htmlProvider = new HTMLProvider(this.context, panel.webview);
		const imageUris = await this.getImageUris(galleryFolder);
		this.gFolders = await utils.getFolders(imageUris);
		this.gFolders = this.customSorter.sort(this.gFolders);
		panel.webview.html = htmlProvider.fullHTML();

		const imageSizeStat = utils.getImageSizeStat(this.gFolders);
		reporter.sendTelemetryEvent('gallery.createPanel', {}, {
			"duration": Date.now() - startTime,
			"folderCount": Object.keys(this.gFolders).length,
			"imageCount": imageSizeStat.count,
			"imageSizeMean": imageSizeStat.mean,
			"imageSizeStd": imageSizeStat.std,
		});

		return panel;
	}

	private async sendContentBatches(webview: vscode.Webview) {
		const htmlProvider = new HTMLProvider(this.context, webview);
		const folderEntries = Object.values(this.gFolders);
		const BATCH_SIZE = 200;

		// Phase 1: send all folders immediately WITHOUT thumbnails (shimmer placeholders)
		let batch: Record<string, any> = {};
		let batchImageCount = 0;
		let batchIndex = 0;

		const sendBatch = () => {
			if (Object.keys(batch).length === 0) { return; }
			webview.postMessage({
				command: "POST.gallery.responseContentBatch",
				batchIndex: batchIndex++,
				content: JSON.stringify(batch),
			});
			batch = {};
			batchImageCount = 0;
		};

		for (const folder of folderEntries) {
			const images = Object.values(folder.images);
			batch[folder.id] = {
				status: "",
				barHtml: htmlProvider.folderBarHTML(folder),
				gridHtml: htmlProvider.imageGridHTML(folder, true),
				images: Object.fromEntries(
					images.map(image => [image.id, {
						status: image.status,
						containerHtml: htmlProvider.singleImageHTML(image),
					}])
				),
			};
			batchImageCount += images.length;
			if (batchImageCount >= BATCH_SIZE) {
				sendBatch();
			}
		}
		sendBatch();

		const imageSizeStat = utils.getImageSizeStat(this.gFolders);
		webview.postMessage({
			command: "POST.gallery.responseContentComplete",
			totalFolders: folderEntries.length,
			totalImages: imageSizeStat.count,
		});

		reporter.sendTelemetryEvent("gallery.messageListener.requestContentDOMs", {}, {
			"folderCount": folderEntries.length,
			"imageCount": imageSizeStat.count,
			"imageSizeMean": imageSizeStat.mean,
			"imageSizeStd": imageSizeStat.std,
		});

		// Phase 2: generate thumbnails in background, push updates per folder
		for (const folder of folderEntries) {
			const images = Object.values(folder.images);
			const thumbItems = images.map(img => ({ imageId: img.id, fsPath: img.uri.fsPath }));
			await utils.asyncPool(20, thumbItems, async (item) => {
				const dataUri = await utils.generateThumbnail(item.fsPath);
				const img = folder.images[item.imageId];
				if (img && dataUri) { img.thumbnailDataUri = dataUri; }
				return dataUri;
			});

			const thumbUpdates: Record<string, string> = {};
			for (const img of images) {
				if (img.thumbnailDataUri) {
					thumbUpdates[img.id] = img.thumbnailDataUri;
				}
			}
			if (Object.keys(thumbUpdates).length > 0) {
				webview.postMessage({
					command: "POST.gallery.responseThumbnails",
					folderId: folder.id,
					thumbnails: thumbUpdates,
				});
			}
		}
	}

	public messageListener(message: Record<string, any>, webview: vscode.Webview) {
		const telemetryPrefix = "gallery.messageListener";
		switch (message.command) {
			case "POST.gallery.openImageViewer":
				vscode.commands.executeCommand(
					'vscode.open',
					vscode.Uri.file(message.path),
					{
						preserveFocus: false,
						preview: message.preview,
						viewColumn: vscode.ViewColumn.Two,
					},
				);
				reporter.sendTelemetryEvent(`${telemetryPrefix}.openImageViewer`, {
					'preview': message.preview.toString(),
				});
				break;

			case "POST.gallery.requestSort":
				this.gFolders = this.customSorter.sort(this.gFolders, message.valueName, message.ascending);
				reporter.sendTelemetryEvent(`${telemetryPrefix}.requestSort`, {
					'valueName': this.customSorter.valueName,
					'ascending': this.customSorter.ascending.toString(),
				});
				this.sendContentBatches(webview);
				break;

			case "POST.gallery.requestContentDOMs":
				this.sendContentBatches(webview);
				break;
		}
	}

	private queueDelta(type: string, uri: vscode.Uri, webview: vscode.Webview) {
		this.deltaBuffer.push({ type, uri });
		if (this.deltaTimer) { clearTimeout(this.deltaTimer); }
		this.deltaTimer = setTimeout(() => this.flushDeltas(webview), this.deltaDebounceMs);
	}

	private async flushDeltas(webview: vscode.Webview) {
		const deltas = this.deltaBuffer;
		this.deltaBuffer = [];
		this.deltaTimer = null;

		if (deltas.length > this.deltaBatchThreshold) {
			const imageUris = await this.getImageUris(this.galleryFolder);
			this.gFolders = await utils.getFolders(imageUris);
			this.gFolders = this.customSorter.sort(this.gFolders);
			await this.sendContentBatches(webview);
			return;
		}

		const htmlProvider = new HTMLProvider(this.context, webview);

		for (const delta of deltas) {
			switch (delta.type) {
				case 'create': {
					const folders = await utils.getFolders([delta.uri], "create");
					const folder = Object.values(folders)[0];
					const image = Object.values(folder.images)[0];
					image.thumbnailDataUri = await utils.generateThumbnail(image.uri.fsPath);
					const isNewFolder = !this.gFolders.hasOwnProperty(folder.id);

					if (isNewFolder) {
						this.gFolders[folder.id] = folder;
					} else if (!this.gFolders[folder.id].images.hasOwnProperty(image.id)) {
						this.gFolders[folder.id].images[image.id] = image;
					}
					this.gFolders = this.customSorter.sort(this.gFolders);

					const payload: Record<string, any> = {
						command: "POST.gallery.responseDeltaCreate",
						folderId: folder.id,
						imageId: image.id,
						containerHtml: htmlProvider.singleImageHTML(image),
						sortedIndex: Object.keys(this.gFolders[folder.id].images).indexOf(image.id),
					};
					if (isNewFolder) {
						payload.folderBarHtml = htmlProvider.folderBarHTML(folder);
						payload.gridHtml = htmlProvider.imageGridHTML(folder, true);
					}
					webview.postMessage(payload);
					break;
				}
				case 'delete': {
					const folders = await utils.getFolders([delta.uri], "delete");
					const folder = Object.values(folders)[0];
					const imageId = utils.hash256(webview.asWebviewUri(delta.uri).path);
					let deleteFolder = false;

					if (this.gFolders.hasOwnProperty(folder.id)) {
						if (this.gFolders[folder.id].images.hasOwnProperty(imageId)) {
							delete this.gFolders[folder.id].images[imageId];
						}
						if (Object.keys(this.gFolders[folder.id].images).length === 0) {
							delete this.gFolders[folder.id];
							deleteFolder = true;
						}
					}

					webview.postMessage({
						command: "POST.gallery.responseDeltaDelete",
						folderId: folder.id,
						imageId: imageId,
						deleteFolder: deleteFolder,
					});
					break;
				}
				case 'change': {
					const folders = await utils.getFolders([delta.uri], "change");
					const folder = Object.values(folders)[0];
					const image = Object.values(folder.images)[0];
					image.thumbnailDataUri = await utils.generateThumbnail(image.uri.fsPath);

					if (this.gFolders.hasOwnProperty(folder.id) &&
						this.gFolders[folder.id].images.hasOwnProperty(image.id)) {
						this.gFolders[folder.id].images[image.id] = image;

						webview.postMessage({
							command: "POST.gallery.responseDeltaChange",
							folderId: folder.id,
							imageId: image.id,
							containerHtml: htmlProvider.singleImageHTML(image),
						});
					}
					break;
				}
			}
		}
	}

	public createFileWatcher(webview: vscode.Webview, galleryFolder?: vscode.Uri) {
		const globPattern = utils.getGlob();
		const watcher = vscode.workspace.createFileSystemWatcher(
			galleryFolder ?
				new vscode.RelativePattern(galleryFolder, globPattern) : globPattern
		);
		watcher.onDidCreate(uri => this.queueDelta('create', uri, webview));
		watcher.onDidDelete(uri => this.queueDelta('delete', uri, webview));
		watcher.onDidChange(uri => this.queueDelta('change', uri, webview));
		return watcher;
	}
}