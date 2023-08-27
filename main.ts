import {App, Events, Plugin, PluginSettingTab, Setting, TAbstractFile, TFolder} from 'obsidian';

import {Dropbox, DropboxAuth, DropboxResponse} from 'dropbox';

interface DropboxSyncSettings {
	vaultPath: string,
	refreshToken?: string;
	accessToken?: string;
	tokenExpiresAt: number,
}

const DEFAULT_SETTINGS: DropboxSyncSettings = {
	vaultPath: '',
	tokenExpiresAt: 0,
};

const CLIENT_ID = 'gcd92pv67w5evql';
const OAUTH_CODE = 'dropbox-sync/oauth-code';

class VaultListener extends Events {
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
		this.trigger('folder', file);
	}

	onCreate(file: TAbstractFile) {
		if (file instanceof TFolder)
			this.trigger('folder', file);
		else
			this.trigger('file', file);
	}

	onDelete(file: TAbstractFile) {
		this.trigger('delete', file.path);
	}

	onRename(file: TAbstractFile, oldPath: string) {
		this.trigger('delete', oldPath);
		this.onCreate(file);
	}
}

class DropboxListener extends Events {
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

const BLOCK_SIZE = 4 * 1024 * 1024;
async function contentHash(data: ArrayBuffer) {
    let chunksNum = Math.ceil(data.byteLength / BLOCK_SIZE);
    let result = new Uint8Array(32 * chunksNum);
    for (let i = 0; i < chunksNum; i += 1) {
        let chunk = data.slice(i * BLOCK_SIZE, (i+1) * BLOCK_SIZE);
        let chunkHash = await crypto.subtle.digest('SHA-256', chunk);
        result.set(new Uint8Array(chunkHash), i * 32);
    }
    let resultHash = await crypto.subtle.digest('SHA-256', result);
    return [...new Uint8Array(resultHash)]
        .map(x => x.toString(16).padStart(2, '0')).join('');
}

export default class DropboxSyncPlugin extends Plugin {
	codeVerifier: string = '';
	settings: DropboxSyncSettings;
	dropboxListener: DropboxListener;
	vaultListener: VaultListener;

	async getDropboxAuth(): Promise<DropboxAuth> {
		let res = new DropboxAuth({
			clientId: CLIENT_ID,
			refreshToken: this.settings.refreshToken,
			accessToken: this.settings.accessToken,
		});
		res.setAccessTokenExpiresAt(new Date(this.settings.tokenExpiresAt));
		if (this.settings.refreshToken)
			await res.checkAndRefreshAccessToken();
		return res;
	}

	isSignedIn(): boolean {
		return this.settings.refreshToken !== undefined;
	}

	getVaultPath(entry: any) {
		let path = entry.path_display.substring(this.settings.vaultPath.length);
		if (path.startsWith('/'))
			path = path.substring(1);
		return path;
	}

	async createVaultFolder(path: string) {
		if (!path)
			return;		
		if (!this.app.vault.getAbstractFileByPath(path))
			await this.app.vault.createFolder(path);		
	}

	async copyFileFromDropbox(entry: {path_display: any}, path: string) {
		let dir = path.split('/').slice(0, -1).join('/');
		await this.createVaultFolder(dir);
		let dbx = new Dropbox({auth: await this.getDropboxAuth()});
		let {result} : any = await dbx.filesDownload({path: entry.path_display});
		if (this.app.vault.getAbstractFileByPath(path))
		{
			let dbxHash = result.content_hash;
			let vaultHash = await contentHash(await this.app.vault.adapter.readBinary(path));
			if (dbxHash === vaultHash)
				return;
		}
		await this.app.vault.adapter.writeBinary(path,
			Buffer.from(await result.fileBlob.arrayBuffer()));
	}

	async copyFileToDropbox(path: string) {
		let dbxPath = `${this.settings.vaultPath}/${path}`;
		let dbx = new Dropbox({auth: await this.getDropboxAuth()});
		try {
			let dbxHash = (await dbx.filesGetMetadata({path: dbxPath})).result.content_hash;
			let vaultHash = await contentHash(await this.app.vault.adapter.readBinary(path));
			if (dbxHash === vaultHash)
				return;
			console.log(vaultHash, dbxHash);
		} catch(e) {
			if (!e.error.error.path['.tag'])
				throw e;
			console.log('file does not exist on dropbox');
		}
		await dbx.filesUpload({
			path: dbxPath,
			contents: await this.app.vault.adapter.readBinary(path),
			mode: {'.tag': 'overwrite'},
		});
	}

	async startServices() {
		if (!this.isSignedIn())
			return;
		this.dropboxListener = new DropboxListener(
			await this.getDropboxAuth(), this.settings.vaultPath);
		this.dropboxListener.start();
		this.dropboxListener.on('file', async (entry) => {
			let path = this.getVaultPath(entry);
			let afile = this.app.vault.getAbstractFileByPath(path) as {stat: {mtime: number}} | null;
			if (afile) {
				let afilem = afile.stat.mtime;
				let dfilem = new Date(entry.server_modified).getTime();
				if (dfilem > afilem) {
					console.log('upload file from dropbox');
					this.copyFileFromDropbox(entry, path);
				} else {
					console.log('file on dropbox is outdated');
				}
			} else {
				console.log('upload new file from dropbox');
				this.copyFileFromDropbox(entry, path);
			}
		});
		this.dropboxListener.on('folder', async (entry) => {
			let path = this.getVaultPath(entry);
			await this.createVaultFolder(path);
		});
		this.vaultListener = new VaultListener(this.app);
		this.vaultListener.start();
		this.vaultListener.on('file', async (file) => {
			await this.copyFileToDropbox(file.path);
		});
		this.vaultListener.on('folder', async (folder) => {
			let dbx = new Dropbox({auth: await this.getDropboxAuth()});
			await dbx.filesCreateFolderV2({path: `${this.settings.vaultPath}/${folder.path}`});
		});
	}

	stopServices() {
		if (!this.isSignedIn())
			return;
		this.dropboxListener.stop();
		this.vaultListener.stop();
	}

	async onload() {
		await this.loadSettings();
		this.app.vault
		let dbxAuth = await this.getDropboxAuth();
		await this.startServices();
		this.registerObsidianProtocolHandler(OAUTH_CODE, async params => {
			dbxAuth.setCodeVerifier(this.codeVerifier);
			let {result: res} = await dbxAuth.getAccessTokenFromCode(`obsidian://${OAUTH_CODE}`, params.code) as
				DropboxResponse<{refresh_token: string, access_token: string, expires_in: number}>;
			this.settings.refreshToken = res.refresh_token;
			this.settings.accessToken = res.access_token;
			this.settings.tokenExpiresAt = Date.now() + res.expires_in*1000;
			await this.saveSettings();
			dbxAuth = await this.getDropboxAuth();
		});
		this.addSettingTab(new DropboxSyncSettingsTab(this.app, this));
	}

	onunload() {
		this.stopServices();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class DropboxSyncSettingsTab extends PluginSettingTab {
	plugin: DropboxSyncPlugin;

	constructor(app: App, plugin: DropboxSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName('Sign In to Dropbox')
			.setDesc('Click the button to start OAuth flow')
			.addButton(button => button
				.setButtonText('Sign In')
				.onClick(async () => {
					let dbxAuth = new DropboxAuth({clientId: CLIENT_ID});
					let url = await dbxAuth.getAuthenticationUrl(
						`obsidian://${OAUTH_CODE}`, undefined, 'code',
						'offline',
						['account_info.read', 'files.metadata.write',
							'files.metadata.read', 'files.content.write',
							'files.content.read'],
						'none', true);
					this.plugin.codeVerifier = dbxAuth.getCodeVerifier();
					window.open(''+url);
				}));
		let vaultPath = '';
		new Setting(containerEl)
			.setName('Vault Path')
			.setDesc('The path in Dropbox to sync to')
			.addText(text => text
				.setPlaceholder('/path/to/vault')
				.setValue(this.plugin.settings.vaultPath)
				.onChange(async (value) => {
					vaultPath = value;
				}))
			.addExtraButton(button => button
				.setIcon('save')
				.setTooltip('Save')
				.onClick(async () => {
					this.plugin.settings.vaultPath = vaultPath;
					await this.plugin.saveSettings();
				}));
	}
}
