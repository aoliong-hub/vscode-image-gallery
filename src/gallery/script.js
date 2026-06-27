const vscode = acquireVsCodeApi();

// Flat image data store: imageId -> { folderId, meta, src, path, placeholderSrc, status }
let gImages = {};
// Folder order and metadata: folderId -> { bar (DOM), path, imageIds (ordered array) }
let gFolders = {};
// Tracks which folderIds exist in the current batch sequence
let batchGeneration = 0;
let currentBatchFolderIds = new Set();

function init() {
	initMessageListeners();
	EventListener.addAllToToolbar();
	EventListener.addDelegatedListeners();
	VirtualScroller.init();
	DOMManager.requestContentDOMs();
}

function initMessageListeners() {
	window.addEventListener("message", event => {
		const message = event.data;
		const command = message.command;
		delete message.command;
		switch (command) {
			case "POST.gallery.responseContentBatch":
				DOMManager.handleBatch(message);
				break;
			case "POST.gallery.responseContentComplete":
				DOMManager.handleComplete(message);
				break;
			case "POST.gallery.responseDeltaCreate":
				DOMManager.handleDeltaCreate(message);
				break;
			case "POST.gallery.responseDeltaDelete":
				DOMManager.handleDeltaDelete(message);
				break;
			case "POST.gallery.responseDeltaChange":
				DOMManager.handleDeltaChange(message);
				break;
			case "POST.gallery.responseThumbnails":
				DOMManager.handleThumbnails(message);
				break;
		}
	});
}

// ─── ImageLoader: concurrency-limited image loading ───

class ImageLoader {
	static MAX_CONCURRENT = 12;
	static activeCount = 0;
	static queue = [];
	static loadedSrcs = new Map(); // imageId -> loaded src (cache)

	static enqueue(imgElement, src) {
		if (imgElement.classList.contains('loaded') || imgElement._queued) { return; }

		// If previously loaded, restore from cache instantly
		const imageId = imgElement.id;
		if (imageId && ImageLoader.loadedSrcs.has(imageId)) {
			imgElement.src = ImageLoader.loadedSrcs.get(imageId);
			imgElement.classList.replace('unloaded', 'loaded');
			return;
		}

		imgElement._queued = true;
		if (ImageLoader.activeCount < ImageLoader.MAX_CONCURRENT) {
			ImageLoader._load(imgElement, src);
		} else {
			ImageLoader.queue.push({ imgElement, src });
		}
	}

	static _load(imgElement, src) {
		ImageLoader.activeCount++;
		imgElement.src = src;
		const done = () => {
			imgElement._queued = false;
			ImageLoader.activeCount--;
			ImageLoader._dequeue();
		};
		imgElement.onload = () => {
			imgElement.classList.replace('unloaded', 'loaded');
			if (imgElement.id) { ImageLoader.loadedSrcs.set(imgElement.id, src); }
			done();
		};
		imgElement.onerror = done;
	}

	static _dequeue() {
		while (ImageLoader.queue.length > 0 && ImageLoader.activeCount < ImageLoader.MAX_CONCURRENT) {
			const next = ImageLoader.queue.shift();
			if (next.imgElement.isConnected && next.imgElement.classList.contains('unloaded')) {
				ImageLoader._load(next.imgElement, next.src);
			} else {
				next.imgElement._queued = false;
			}
		}
	}

	static cancelForElement(imgElement) {
		ImageLoader.queue = ImageLoader.queue.filter(item => item.imgElement !== imgElement);
		imgElement._queued = false;
	}

	static cancelAll() {
		ImageLoader.queue = [];
	}
}

// ─── VirtualScroller: only render visible rows ───

class VirtualScroller {
	static ROW_HEIGHT = 260;
	static FOLDER_BAR_HEIGHT = 55;
	static ITEM_MIN_WIDTH = 260;
	static BUFFER_PX = 1500;

	static containerEl = null;
	static columnsPerRow = 4;
	static layoutEntries = [];
	static totalHeight = 0;
	static renderedKeys = new Map(); // key -> DOM element
	static collapsedFolders = new Set();
	static scrollTicking = false;
	static resizeTimer = null;

	static init() {
		VirtualScroller.containerEl = document.querySelector('.gallery-content');
		VirtualScroller.containerEl.style.position = 'relative';
		VirtualScroller.recalcColumns();

		window.addEventListener('scroll', () => {
			if (!VirtualScroller.scrollTicking) {
				VirtualScroller.scrollTicking = true;
				requestAnimationFrame(() => {
					VirtualScroller.render();
					VirtualScroller.scrollTicking = false;
				});
			}
		});

		window.addEventListener('resize', () => {
			if (VirtualScroller.resizeTimer) { clearTimeout(VirtualScroller.resizeTimer); }
			VirtualScroller.resizeTimer = setTimeout(() => {
				const oldCols = VirtualScroller.columnsPerRow;
				VirtualScroller.recalcColumns();
				if (oldCols !== VirtualScroller.columnsPerRow) {
					VirtualScroller.rebuildLayout();
					VirtualScroller.render();
				}
			}, 200);
		});
	}

	static recalcColumns() {
		const width = VirtualScroller.containerEl
			? VirtualScroller.containerEl.clientWidth
			: window.innerWidth;
		VirtualScroller.columnsPerRow = Math.max(1, Math.floor(width / VirtualScroller.ITEM_MIN_WIDTH));
	}

	static rebuildLayout() {
		const entries = [];
		let top = 0;
		const folderIds = Object.keys(gFolders);

		for (const folderId of folderIds) {
			const folder = gFolders[folderId];
			entries.push({
				type: 'folder-bar',
				folderId,
				top,
				height: VirtualScroller.FOLDER_BAR_HEIGHT,
			});
			top += VirtualScroller.FOLDER_BAR_HEIGHT;

			if (!VirtualScroller.collapsedFolders.has(folderId)) {
				const imageIds = folder.imageIds;
				const cols = VirtualScroller.columnsPerRow;
				const rowCount = Math.ceil(imageIds.length / cols);
				for (let r = 0; r < rowCount; r++) {
					const rowImageIds = imageIds.slice(r * cols, (r + 1) * cols);
					entries.push({
						type: 'grid-row',
						folderId,
						rowIndex: r,
						imageIds: rowImageIds,
						top,
						height: VirtualScroller.ROW_HEIGHT,
					});
					top += VirtualScroller.ROW_HEIGHT;
				}
			}
		}

		VirtualScroller.layoutEntries = entries;
		VirtualScroller.totalHeight = top;
		VirtualScroller.containerEl.style.height = top + 'px';
	}

	static render() {
		if (VirtualScroller.layoutEntries.length === 0) {
			VirtualScroller.containerEl.innerHTML = "<p>No image found in this folder.</p>";
			return;
		}

		const scrollTop = window.scrollY || document.documentElement.scrollTop;
		const viewportHeight = window.innerHeight;
		const rangeTop = scrollTop - VirtualScroller.BUFFER_PX;
		const rangeBottom = scrollTop + viewportHeight + VirtualScroller.BUFFER_PX;

		const visibleStart = VirtualScroller._binarySearchStart(rangeTop);
		const visibleEnd = VirtualScroller._binarySearchEnd(rangeBottom);

		const newKeys = new Set();

		for (let i = visibleStart; i <= visibleEnd && i < VirtualScroller.layoutEntries.length; i++) {
			const entry = VirtualScroller.layoutEntries[i];
			const key = entry.type === 'folder-bar'
				? 'fb-' + entry.folderId
				: 'gr-' + entry.folderId + '-' + entry.rowIndex;
			newKeys.add(key);

			if (!VirtualScroller.renderedKeys.has(key)) {
				const dom = VirtualScroller._createEntryDOM(entry);
				dom.style.position = 'absolute';
				dom.style.top = entry.top + 'px';
				dom.style.left = '0';
				dom.style.right = '0';
				VirtualScroller.containerEl.appendChild(dom);
				VirtualScroller.renderedKeys.set(key, dom);

				if (entry.type === 'grid-row') {
					const imgs = dom.querySelectorAll('.image.unloaded');
					imgs.forEach(img => ImageLoader.enqueue(img, img.dataset.src));
				}
			}
		}

		// Remove elements that scrolled out of range
		for (const [key, dom] of VirtualScroller.renderedKeys) {
			if (!newKeys.has(key)) {
				// Cancel pending image loads for this row
				if (key.startsWith('gr-')) {
					const imgs = dom.querySelectorAll('.image');
					imgs.forEach(img => {
						if (img._queued) { ImageLoader.cancelForElement(img); }
					});
				}
				dom.remove();
				VirtualScroller.renderedKeys.delete(key);
			}
		}

		// Update folder count in toolbar
		const folderCount = Object.keys(gFolders).length;
		const imageCount = Object.values(gFolders).reduce((acc, f) => acc + f.imageIds.length, 0);
		const countText = (obj, n) => `${n} ${obj}${n === 1 ? '' : 's'} found`;
		const folderCountEl = document.querySelector('.toolbar .folder-count');
		if (folderCountEl) {
			folderCountEl.textContent = countText('folder', folderCount) + ', ' + countText('image', imageCount);
		}
	}

	static _binarySearchStart(targetTop) {
		let lo = 0, hi = VirtualScroller.layoutEntries.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const entry = VirtualScroller.layoutEntries[mid];
			if (entry.top + entry.height < targetTop) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	static _binarySearchEnd(targetBottom) {
		let lo = 0, hi = VirtualScroller.layoutEntries.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >>> 1;
			if (VirtualScroller.layoutEntries[mid].top > targetBottom) {
				hi = mid - 1;
			} else {
				lo = mid;
			}
		}
		return lo;
	}

	static _createEntryDOM(entry) {
		if (entry.type === 'folder-bar') {
			const folder = gFolders[entry.folderId];
			const bar = folder.bar.cloneNode(true);
			bar.classList.add('virtual-folder-bar');
			const isCollapsed = VirtualScroller.collapsedFolders.has(entry.folderId);
			bar.dataset.state = isCollapsed ? 'collapsed' : 'expanded';
			const arrowImg = bar.querySelector(`#${entry.folderId}-arrow-img`);
			if (arrowImg) {
				arrowImg.src = isCollapsed ? arrowImg.dataset.chevronRight : arrowImg.dataset.chevronDown;
			}
			const itemsCount = bar.querySelector(`#${entry.folderId}-items-count`);
			if (itemsCount) {
				const n = gFolders[entry.folderId].imageIds.length;
				itemsCount.textContent = `${n} image${n === 1 ? '' : 's'} found`;
			}
			return bar;
		}

		// grid-row
		const row = document.createElement('div');
		row.className = 'virtual-row grid';
		row.style.gridTemplateColumns = `repeat(${VirtualScroller.columnsPerRow}, 1fr)`;

		for (const imageId of entry.imageIds) {
			const imgData = gImages[imageId];
			if (!imgData) { continue; }
			const container = imgData.containerDOM.cloneNode(true);
			row.appendChild(container);
		}
		return row;
	}

	static clearAll() {
		for (const [, dom] of VirtualScroller.renderedKeys) {
			dom.remove();
		}
		VirtualScroller.renderedKeys.clear();
		ImageLoader.cancelAll();
	}

	static toggleFolder(folderId) {
		if (VirtualScroller.collapsedFolders.has(folderId)) {
			VirtualScroller.collapsedFolders.delete(folderId);
		} else {
			VirtualScroller.collapsedFolders.add(folderId);
		}
		VirtualScroller.clearAll();
		VirtualScroller.rebuildLayout();
		VirtualScroller.render();
	}

	static collapseAllFolders() {
		for (const folderId of Object.keys(gFolders)) {
			VirtualScroller.collapsedFolders.add(folderId);
		}
		VirtualScroller.clearAll();
		VirtualScroller.rebuildLayout();
		VirtualScroller.render();
	}

	static expandAllFolders() {
		VirtualScroller.collapsedFolders.clear();
		VirtualScroller.clearAll();
		VirtualScroller.rebuildLayout();
		VirtualScroller.render();
	}
}

// ─── DOMManager ───

class DOMManager {
	static htmlToDOM(html) {
		const template = document.createElement("template");
		template.innerHTML = html.trim();
		return template.content.firstChild;
	}

	static requestContentDOMs() {
		batchGeneration++;
		currentBatchFolderIds = new Set();
		vscode.postMessage({
			command: "POST.gallery.requestContentDOMs",
		});
	}

	static handleBatch(message) {
		const content = JSON.parse(message.content);

		for (const [folderId, folder] of Object.entries(content)) {
			currentBatchFolderIds.add(folderId);

			const barDOM = DOMManager.htmlToDOM(folder.barHtml);
			const imageIds = [];

			for (const [imageId, image] of Object.entries(folder.images)) {
				const containerDOM = DOMManager.htmlToDOM(image.containerHtml);
				const imgEl = containerDOM.querySelector('.image');
				gImages[imageId] = {
					folderId,
					containerDOM,
					status: image.status,
					src: imgEl ? imgEl.dataset.src : '',
					path: imgEl ? imgEl.dataset.path : '',
					meta: imgEl ? imgEl.dataset.meta : '{}',
				};
				imageIds.push(imageId);
			}

			gFolders[folderId] = {
				bar: barDOM,
				path: folder.barHtml,
				imageIds,
			};
		}

		// Render progressively as each batch arrives
		VirtualScroller.recalcColumns();
		VirtualScroller.rebuildLayout();
		VirtualScroller.render();
	}

	static handleComplete(_message) {
		// Remove folders not present in this generation
		for (const folderId of Object.keys(gFolders)) {
			if (!currentBatchFolderIds.has(folderId)) {
				const folder = gFolders[folderId];
				for (const imageId of folder.imageIds) {
					delete gImages[imageId];
				}
				delete gFolders[folderId];
			}
		}

		VirtualScroller.clearAll();
		VirtualScroller.recalcColumns();
		VirtualScroller.rebuildLayout();
		VirtualScroller.render();
	}

	static handleDeltaCreate(message) {
		const { folderId, imageId, containerHtml, folderBarHtml, gridHtml, sortedIndex, folderSortedIndex } = message;

		if (folderBarHtml) {
			const barDOM = DOMManager.htmlToDOM(folderBarHtml);
			gFolders[folderId] = { bar: barDOM, imageIds: [] };
		}

		if (gFolders[folderId] && containerHtml) {
			const containerDOM = DOMManager.htmlToDOM(containerHtml);
			const imgEl = containerDOM.querySelector('.image');
			gImages[imageId] = {
				folderId,
				containerDOM,
				status: '',
				src: imgEl ? imgEl.dataset.src : '',
				path: imgEl ? imgEl.dataset.path : '',
				meta: imgEl ? imgEl.dataset.meta : '{}',
			};
			const idx = (sortedIndex !== undefined && sortedIndex >= 0 && sortedIndex <= gFolders[folderId].imageIds.length)
				? sortedIndex : gFolders[folderId].imageIds.length;
			gFolders[folderId].imageIds.splice(idx, 0, imageId);
		}

		VirtualScroller.clearAll();
		VirtualScroller.rebuildLayout();
		VirtualScroller.render();
	}

	static handleDeltaDelete(message) {
		const { folderId, imageId, deleteFolder } = message;

		if (gFolders[folderId]) {
			gFolders[folderId].imageIds = gFolders[folderId].imageIds.filter(id => id !== imageId);
			delete gImages[imageId];
			if (deleteFolder) {
				delete gFolders[folderId];
				VirtualScroller.collapsedFolders.delete(folderId);
			}
		}

		VirtualScroller.clearAll();
		VirtualScroller.rebuildLayout();
		VirtualScroller.render();
	}

	static handleDeltaChange(message) {
		const { folderId, imageId, containerHtml } = message;

		if (gImages[imageId]) {
			const containerDOM = DOMManager.htmlToDOM(containerHtml);
			const imgEl = containerDOM.querySelector('.image');
			gImages[imageId].containerDOM = containerDOM;
			gImages[imageId].src = imgEl ? imgEl.dataset.src : '';
			gImages[imageId].status = 'refresh';
		}

		VirtualScroller.clearAll();
		VirtualScroller.render();
	}

	static handleThumbnails(message) {
		const { folderId, thumbnails } = message;
		for (const [imageId, dataUri] of Object.entries(thumbnails)) {
			if (gImages[imageId]) {
				gImages[imageId].thumbnailSrc = dataUri;
				// Update the containerDOM's img src so future renders use the thumbnail
				const imgEl = gImages[imageId].containerDOM.querySelector('.image');
				if (imgEl) {
					imgEl.src = dataUri;
					imgEl.classList.replace('unloaded', 'loaded');
				}
			}
			// Cache in ImageLoader so virtual scroller uses it on render
			ImageLoader.loadedSrcs.set(imageId, dataUri);
		}
		// Re-render to update currently visible images with thumbnails
		VirtualScroller.clearAll();
		VirtualScroller.render();
	}
}

// ─── EventListener ───

class EventListener {
	static addAllToToolbar() {
		document.querySelector(".toolbar .collapse-all").addEventListener(
			"click", () => VirtualScroller.collapseAllFolders()
		);
		document.querySelector(".toolbar .expand-all").addEventListener(
			"click", () => VirtualScroller.expandAllFolders()
		);
		document.querySelector(".toolbar .dropdown").addEventListener(
			"change", () => EventListener.sortRequest()
		);
		document.querySelector(".toolbar .sort-order-arrow").addEventListener(
			"click", () => {
				EventListener.toggleSortOrder();
				EventListener.sortRequest();
			}
		);
	}

	static addDelegatedListeners() {
		const content = document.querySelector('.gallery-content');

		content.addEventListener('click', (e) => {
			// folder bar click
			const folderBar = e.target.closest('.folder');
			if (folderBar) {
				VirtualScroller.toggleFolder(folderBar.id);
				return;
			}
			// image click (single = preview)
			const container = e.target.closest('.image-container');
			if (container) {
				const img = container.querySelector('.image');
				if (img) { EventListener.openImageViewer(img.dataset.path, true); }
			}
		});

		content.addEventListener('dblclick', (e) => {
			const container = e.target.closest('.image-container');
			if (container) {
				const img = container.querySelector('.image');
				if (img) { EventListener.openImageViewer(img.dataset.path, false); }
			}
		});

		content.addEventListener('mouseover', (e) => {
			const container = e.target.closest('.image-container');
			if (!container) { return; }
			const img = container.querySelector('.image');
			const tooltip = container.querySelector('.tooltip-text');
			if (img && tooltip) {
				EventListener.showImageMetadata(tooltip, img.dataset.meta, img);
			}
		});

		content.addEventListener('mouseout', (e) => {
			const container = e.target.closest('.image-container');
			if (!container) { return; }
			const tooltip = container.querySelector('.tooltip-text');
			if (tooltip) { tooltip.textContent = ''; }
		});
	}

	static openImageViewer(path, preview) {
		vscode.postMessage({
			command: "POST.gallery.openImageViewer",
			path: path,
			preview: preview,
		});
	}

	static showImageMetadata(tooltipDOM, metadata, image) {
		const data = JSON.parse(metadata);

		const pow = Math.max(0, Math.floor(Math.log(data.size) / Math.log(1024)));
		const unit = ["bytes", "kB", "MB", "GB", "TB", "PB"][pow];
		const sizeStr = (data.size / Math.pow(1024, pow)).toFixed(2) + " " + unit;

		const dateOptions = {
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		};
		const ctimeStr = new Date(data.ctime).toLocaleString("en-US", dateOptions);
		const mtimeStr = new Date(data.mtime).toLocaleString("en-US", dateOptions);

		tooltipDOM.textContent = [
			`Dimensions: ${image.naturalWidth} x ${image.naturalHeight}`,
			`Type: ${data.ext}`,
			`Size: ${sizeStr}`,
			`Modified: ${mtimeStr}`,
			`Created: ${ctimeStr}`,
		].join("\n");
	}

	static toggleSortOrder() {
		const sortArrowImg = document.querySelector(".toolbar .sort-order-arrow-img");
		if (sortArrowImg.src.includes("arrow-up.svg")) {
			sortArrowImg.src = sortArrowImg.dataset.arrowDown;
			return;
		}
		if (sortArrowImg.src.includes("arrow-down.svg")) {
			sortArrowImg.src = sortArrowImg.dataset.arrowUp;
			return;
		}
	}

	static sortRequest() {
		ImageLoader.cancelAll();
		const dropdownDOM = document.querySelector(".toolbar .dropdown");
		const sortOrderDOM = document.querySelector(".toolbar .sort-order-arrow-img");
		vscode.postMessage({
			command: "POST.gallery.requestSort",
			valueName: dropdownDOM.value,
			ascending: sortOrderDOM.src.includes("arrow-up.svg") ? true : false,
		});
	}
}

(function () {
	init();
}());
