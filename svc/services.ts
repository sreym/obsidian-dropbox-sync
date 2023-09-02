import {Dropbox, DropboxAuth} from "dropbox";
import {DropboxListener, VaultListener} from "./listeners";
import {App, TAbstractFile} from "obsidian";
import {DropboxSyncPluginI, DropboxSyncSettingsI} from "ui/settings";
import {CLIENT_ID} from "consts";

interface TAbstractFileI extends TAbstractFile {
    stat: {mtime: number};
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

export async function getDropboxAuth(settings: DropboxSyncSettingsI): Promise<DropboxAuth> {
    let res = new DropboxAuth({
        clientId: CLIENT_ID,
        refreshToken: settings.refreshToken,
        accessToken: settings.accessToken,
    });
    res.setAccessTokenExpiresAt(new Date(settings.tokenExpiresAt));
    if (settings.refreshToken)
        await res.checkAndRefreshAccessToken();
    return res;
}

export class DropboxSyncServices {
	dropboxListener: DropboxListener;
	vaultListener: VaultListener;

    constructor(public app: App, public plugin: DropboxSyncPluginI) {
        this.app = app;
        this.plugin = plugin;
    }

	getVaultPath(entry: any) {
		let path = entry.path_display.substring(this.plugin.settings.vaultPath.length);
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
		let dbx = new Dropbox({auth: await getDropboxAuth(this.plugin.settings)});
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
		let dbxPath = `${this.plugin.settings.vaultPath}/${path}`;
		let dbx = new Dropbox({auth: await getDropboxAuth(this.plugin.settings)});
		try {
			let dbxFile = (await dbx.filesGetMetadata({path: dbxPath})).result as {content_hash: string};
            let dbxHash = dbxFile.content_hash;
			let vaultHash = await contentHash(await this.app.vault.adapter.readBinary(path));
            console.log(path, vaultHash, dbxHash);
			if (dbxHash === vaultHash)
				return;
		} catch(e) {
			if (e.error.error.path['.tag']!='not_found')
				throw e;
		}
		await dbx.filesUpload({
			path: dbxPath,
			contents: await this.app.vault.adapter.readBinary(path),
			mode: {'.tag': 'overwrite'},
		});
	}
  
    async start() {
        this.dropboxListener = new DropboxListener(
			await getDropboxAuth(this.plugin.settings), this.plugin.settings.vaultPath);
		this.dropboxListener.start();
		this.dropboxListener.on('file', async (entry) => {
			let path = this.getVaultPath(entry);
			let afile = this.app.vault.getAbstractFileByPath(path) as TAbstractFileI | null;
			if (afile) {
				let afilem = afile.stat.mtime;
				let dfilem = new Date(entry.server_modified).getTime();
				if (dfilem > afilem)
					this.copyFileFromDropbox(entry, path);
			} else
				this.copyFileFromDropbox(entry, path);
		});
		this.dropboxListener.on('folder', async (entry) => {
			let path = this.getVaultPath(entry);
			await this.createVaultFolder(path);
		});
		this.dropboxListener.on('deleted', async (entry) => {
			let path = this.getVaultPath(entry);
			let afile = this.app.vault.getAbstractFileByPath(path);
			if (afile)
				await this.app.vault.delete(afile);
		});
        this.dropboxListener.on('synced', () => {
            this.plugin.settings.lastSync = Date.now();
            this.plugin.saveSettings();
        });
        this.vaultListener = new VaultListener(this.app);
		this.vaultListener.start();
		this.vaultListener.on('file', async (file) => {
			await this.copyFileToDropbox(file.path);
		});
		this.vaultListener.on('folder', async (folder) => {
			let dbx = new Dropbox({auth: await getDropboxAuth(this.plugin.settings)});
			await dbx.filesCreateFolderV2({path: `${this.plugin.settings.vaultPath}/${folder.path}`});
		});
		this.vaultListener.on('deleted', async (path) => {
			let dbx = new Dropbox({auth: await getDropboxAuth(this.plugin.settings)});
			await dbx.filesDeleteV2({path: `${this.plugin.settings.vaultPath}/${path}`});
		});
    }

    stop() {
		this.dropboxListener.stop();
		this.vaultListener.stop();
    }
}