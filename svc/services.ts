import {Dropbox, DropboxAuth} from "dropbox";
import {DropboxListener, VaultListener} from "./listeners";
import {App, TAbstractFile} from "obsidian";
import {DropboxSyncPluginI, DropboxSyncSettingsI} from "ui/settings";
import {CLIENT_ID} from "consts";
import {files} from "dropbox/types/dropbox_types"

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

	getVaultPath(entry: files.FileMetadataReference|files.FolderMetadataReference|files.DeletedMetadataReference) {
		let path = (entry.path_display||'').substring(this.plugin.settings.vaultPath.length);
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

	async copyFileFromDropbox(entry: {path_display?: string}, path: string) {
		let dir = path.split('/').slice(0, -1).join('/');
		await this.createVaultFolder(dir);
		let dbx = new Dropbox({auth: await getDropboxAuth(this.plugin.settings)});
		let {result} : any = await dbx.filesDownload({path: entry.path_display!});
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

    async deleteInVault(path: string) {
        let afile = this.app.vault.getAbstractFileByPath(path);
        if (afile)
            await this.app.vault.delete(afile);
    }

    findConflictName(path: string) {
        let m = /(.*)(\.[^.\/]*)$/.exec(path);
        let ext = '', basename;
        if (!m)
            basename = path;
        else
            basename = m[1], ext = m[2];
        if (/\.conflict\d*/.test(ext))
            ext = '';
        else
            basename = basename.replace(/\.conflict\d*$/, '');
        for (let i = 0; ; i += 1) {
            let newPath = `${basename}.conflict${i||''}${ext}`;
            if (!this.app.vault.getAbstractFileByPath(newPath))
                return newPath;
        }
    }

    async sync(dropboxState: Array<files.FileMetadataReference|files.FolderMetadataReference|files.DeletedMetadataReference>) {
        enum Actions {copyFromDropbox, copyToDropbox, deleteInDropbox, deleteInVault, createDuplicate, skip};
        let state = new Map<string, {
            tag: string,
            path: string,
            mtime?: number,
            entry?: files.FileMetadataReference|files.FolderMetadataReference|files.DeletedMetadataReference,
            action: Actions,
        }>();
        dropboxState.forEach(x => {
            let path = this.getVaultPath(x);
            if (!path)
                return;
            state.set(path, {
                tag: x['.tag'],
                path: path,
                mtime: new Date((x as files.FileMetadataReference).server_modified || 0).getTime(),
                entry: x,
                action: Actions.copyFromDropbox,
            });
        });
        let {lastSync = 0} = this.plugin.settings;
        for (let file of this.app.vault.getFiles()) {
            let path = file.path;
            let {mtime} = file.stat;
            let obj = state.get(path);
            if (!obj) {
                // file created after the last sync
                if (mtime > lastSync)
                    obj = {tag: 'file', path, action: Actions.copyToDropbox};
                // file removed after the last sync
                else
                    obj = {tag: 'file', path, action: Actions.deleteInVault};
            } else {
                let dpMtime = obj.mtime || 0;
                if (mtime <= lastSync && dpMtime >= lastSync)
                    obj.action = Actions.copyFromDropbox;
                else if (mtime >= lastSync && dpMtime <= lastSync)
                    obj.action = Actions.copyToDropbox;
                else if (mtime >= lastSync && dpMtime >= lastSync) {
                    let vaultHash = await contentHash(await this.app.vault.adapter.readBinary(path));
                    if ((obj.entry! as {content_hash: string}).content_hash === vaultHash)
                        obj.action = Actions.skip;
                    else
                        obj.action = Actions.createDuplicate;
                } else
                    obj.action = Actions.skip;
            }
            state.set(path, obj);
        }
        let dbx = new Dropbox({auth: await getDropboxAuth(this.plugin.settings)});
        for (let file of state.values()) {
            switch (file.action) {
                case Actions.copyFromDropbox:
                    if (file.tag === 'folder')
                        await this.createVaultFolder(file.path);
                    else
                        await this.copyFileFromDropbox(file.entry!, file.path);
                    break;
                case Actions.copyToDropbox:
                    await this.copyFileToDropbox(file.path);
                    break;
                case Actions.deleteInDropbox:
                    await dbx.filesDeleteV2({path: `${this.plugin.settings.vaultPath}/${file.path}`});
                    break;
                case Actions.deleteInVault:
                    await this.deleteInVault(file.path);
                    break;
                case Actions.createDuplicate:
                    let afile = this.app.vault.getAbstractFileByPath(file.path);
                    let newPath = this.findConflictName(file.path);
                    await this.app.vault.rename(afile!, newPath);
                    await this.copyFileToDropbox(newPath);
                    await this.copyFileFromDropbox(file.entry!, file.path);
                    break;
            }
        }
    }

    async start() {
        let auth = await getDropboxAuth(this.plugin.settings);
        this.dropboxListener = new DropboxListener(auth, this.plugin.settings.vaultPath);
		this.dropboxListener.on('file', async (entry) => {
			let path = this.getVaultPath(entry);
			await this.copyFileFromDropbox(entry, path);
		});
		this.dropboxListener.on('folder', async (entry) => {
			let path = this.getVaultPath(entry);
			await this.createVaultFolder(path);
		});
		this.dropboxListener.on('deleted', async (entry) => {
			let path = this.getVaultPath(entry);
            await this.deleteInVault(path);
		});
        this.dropboxListener.on('synced', () => {
            this.plugin.settings.lastSync = Date.now();
            this.plugin.saveSettings();
        });
        await this.sync(await this.dropboxListener.initialState());
		this.dropboxListener.start();
        this.vaultListener = new VaultListener(this.app);
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
		this.vaultListener.start();
    }

    stop() {
		this.dropboxListener.stop();
		this.vaultListener.stop();
    }
}