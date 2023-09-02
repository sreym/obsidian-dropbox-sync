import {App, Events, TAbstractFile, TFolder} from 'obsidian';
import {Dropbox, DropboxAuth} from 'dropbox';

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
	path: string;
	lastCursor?: string;
	dbx: Dropbox;
	running: boolean;

	constructor(auth: DropboxAuth, path: string) {
		super();
		this.path = path;
		this.dbx = new Dropbox({auth});
	}

	start() {
		this.running = true;
		this.syncAndWaitChanges();
	}

	stop() {
		this.running = false;
	}

	async* traverseCursor(cursor: string) {
		let result;
		do {
			result = (await this.dbx.filesListFolderContinue({cursor})).result;
			yield result;
		} while (result.has_more);
	}

	async syncAndWaitChanges() {
		let {result} = await this.dbx.filesListFolder({path: this.path, recursive: true});
		let {cursor} = result;
		let lastCursor = cursor;
		if (result.has_more) {
			for await (let result of this.traverseCursor(cursor)) {
				lastCursor = result.cursor;
				for (let entry of result.entries) {
					this.trigger(entry['.tag'], entry);
				}
			}
			cursor = lastCursor;
		}
		while (this.running) {
			if (!(await this.dbx.filesListFolderLongpoll({cursor, timeout: 30})).result.changes)
				continue;
			for await (let result of this.traverseCursor(cursor)) {
				lastCursor = result.cursor;
				for (let entry of result.entries) {
					if (!this.running)
						return;
					this.trigger(entry['.tag'], entry);
				}
			}
			cursor = lastCursor;
		}
	}
}
