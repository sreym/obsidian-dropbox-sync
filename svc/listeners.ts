import {App, Events, TAbstractFile, TFolder} from 'obsidian';
import {Dropbox, DropboxAuth} from 'dropbox';
import {traverseListFolder} from 'tools';

export class VaultListener extends Events {
	app: App;
	constructor(app: App) {
		super();
		this.app = app;
	}
	start() {
		this.app.vault.on('modify', this.onModify = this.onModify.bind(this));
		this.app.vault.on('create', this.onCreate = this.onCreate.bind(this));
		this.app.vault.on('delete', this.onDelete = this.onDelete.bind(this));
		this.app.vault.on('rename', this.onRename = this.onRename.bind(this));
	}

	stop() {
		this.app.vault.off('modify', this.onModify);
		this.app.vault.off('create', this.onCreate);
		this.app.vault.off('delete', this.onDelete);
		this.app.vault.off('rename', this.onRename);
	}

	onModify(file: TAbstractFile) {
		if (file instanceof TFolder)
			this.trigger('folder', file);
		else
			this.trigger('file', file);
	}

	onCreate(file: TAbstractFile) {
		if (file instanceof TFolder)
			this.trigger('folder', file);
		else
			this.trigger('file', file);
	}

	onDelete(file: TAbstractFile) {
		this.trigger('deleted', file.path);
	}

	onRename(file: TAbstractFile, oldPath: string) {
		this.trigger('deleted', oldPath);
		this.onCreate(file);
	}
}

export class DropboxListener extends Events {
	dbx: Dropbox;
	initialCursor: string;
	lastCursor?: string;
	path: string;
	running: boolean;

	constructor(auth: DropboxAuth, path: string) {
		super();
		this.path = path;
		this.dbx = new Dropbox({auth});
	}

	async start() {
		this.running = true;
		this.waitChanges();
	}

	stop() {
		this.running = false;
	}
	
	async initialState() {
		let {result} = await this.dbx.filesListFolder({path: this.path, recursive: true});
		let {cursor} = result;
		let initial = [];
		for (let entry of result.entries)
			initial.push(entry);
		let lastCursor = cursor;
		if (result.has_more) {
			for await (let result of traverseListFolder(this.dbx, cursor)) {
				lastCursor = result.cursor;
				for (let entry of result.entries)
					initial.push(entry);
			}
			cursor = lastCursor;
		}
		this.initialCursor = cursor;
		return initial;
	}

	async waitChanges() {
		let cursor = this.initialCursor, lastCursor = cursor;
		while (this.running) {
			if (!(await this.dbx.filesListFolderLongpoll({cursor, timeout: 30})).result.changes)
				continue;
			for await (let result of traverseListFolder(this.dbx, cursor)) {
				lastCursor = result.cursor;
				for (let entry of result.entries) {
					if (!this.running)
						return;
					this.trigger(entry['.tag'], entry);
				}
			}
			this.trigger('synced');
			cursor = lastCursor;
		}
	}
}