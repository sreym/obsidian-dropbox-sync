import {Plugin} from 'obsidian';
import {DropboxResponse} from 'dropbox';
import {VaultListener, DropboxListener} from 'svc/listeners';
import {OAUTH_CODE} from 'consts';
import {DEFAULT_SETTINGS, DropboxSyncPluginI, DropboxSyncSettingsI, DropboxSyncSettingsTab} from 'ui/settings';
import {DropboxSyncServices, getDropboxAuth} from 'svc/services';

export default class DropboxSyncPlugin extends Plugin implements DropboxSyncPluginI {
	codeVerifier: string = '';
	settings: DropboxSyncSettingsI;
	dropboxListener: DropboxListener;
	vaultListener: VaultListener;
	syncServices: DropboxSyncServices;

	isSignedIn(): boolean {
		return this.settings.refreshToken !== undefined;
	}

	async onload() {
		await this.loadSettings();
		this.app.vault
		let dbxAuth = await getDropboxAuth(this.settings);
		if (this.isSignedIn()) {
			this.syncServices = new DropboxSyncServices(this.app, this.settings);
			await this.syncServices.start();
		}		
		this.registerObsidianProtocolHandler(OAUTH_CODE, async params => {
			dbxAuth.setCodeVerifier(this.codeVerifier);
			let {result: res} = await dbxAuth.getAccessTokenFromCode(`obsidian://${OAUTH_CODE}`, params.code) as
				DropboxResponse<{refresh_token: string, access_token: string, expires_in: number}>;
			this.settings.refreshToken = res.refresh_token;
			this.settings.accessToken = res.access_token;
			this.settings.tokenExpiresAt = Date.now() + res.expires_in*1000;
			await this.saveSettings();
			dbxAuth = await getDropboxAuth(this.settings);
		});
		this.addSettingTab(new DropboxSyncSettingsTab(this.app, this));
	}

	onunload() {
		if (this.isSignedIn())
			this.syncServices.stop();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
