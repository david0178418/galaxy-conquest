import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb';
import { InvalidSaveError, parseConquestSave } from './save-state';
import type { ConquestSave } from './save-state';
import { parseCampaignSave } from './campaign-save';
import type { CampaignSave } from './campaign-save';

export const MAX_PROFILES = 10;
const DATABASE_NAME = 'galaxy-conquest-local';
const DATABASE_VERSION = 1;
const PROFILE_STORE = 'profiles';
const SETTINGS_STORE = 'settings';
const SELECTED_PROFILE_KEY = 'selected-profile';

export interface ProfileSummary {
	id: string;
	name: string;
	hasSave: boolean;
	savedAt: number | null;
	hasCampaignSave: boolean;
	campaignSavedAt: number | null;
}

export interface StoredProfile {
	id: string;
	name: string;
	save?: unknown;
	campaignSave?: unknown;
}

export class ProfileStorageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProfileStorageError';
	}
}

export class ProfileLimitError extends ProfileStorageError {
	constructor() {
		super(`A maximum of ${MAX_PROFILES} local profiles is supported.`);
		this.name = 'ProfileLimitError';
	}
}

export class ProfileNotFoundError extends ProfileStorageError {
	constructor() {
		super('That local profile is no longer available. Refresh the profile list and try again.');
		this.name = 'ProfileNotFoundError';
	}
}

export interface ProfileDatabase {
	listProfiles(): Promise<unknown[]>;
	getProfile(id: string): Promise<unknown>;
	createProfile(profile: StoredProfile, maximum: number): Promise<void>;
	updateProfile(
		id: string,
		update: (profile: StoredProfile) => StoredProfile,
	): Promise<void>;
	deleteProfile(id: string): Promise<void>;
	getSelectedProfileId(): Promise<unknown>;
	setSelectedProfileId(id: string | null): Promise<void>;
	close(): void;
}

const isRecord = function (value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
};
const isProfileId = function (value: unknown): value is string {
	return typeof value === 'string' && value.length >= 1 && value.length <= 128;
};
const hasControlCharacters = function (value: string): boolean {
	return Array.from(value).some(function (character) {
		const code = character.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
};
const normalizeProfileName = function (value: string): string {
	const name = value.trim();
	if (!name || name.length > 32 || hasControlCharacters(name))
		throw new ProfileStorageError('Choose a profile name from 1 to 32 characters.');
	return name;
};
const parseStoredProfile = function (value: unknown): StoredProfile {
	if (
		!isRecord(value) ||
		!isProfileId(value.id) ||
		typeof value.name !== 'string' ||
		value.name !== normalizeProfileName(value.name)
	)
		throw new ProfileStorageError(
			'A local profile has invalid data. Its stored progress was left unchanged.',
		);
	return {
		id: value.id,
		name: value.name,
		...('save' in value ? { save: value.save } : {}),
		...('campaignSave' in value ? { campaignSave: value.campaignSave } : {}),
	};
};
const getSavedAt = function (save: unknown): number | null {
	if (!isRecord(save) || typeof save.savedAt !== 'number' || !Number.isFinite(save.savedAt))
		return null;
	return save.savedAt;
};
const summarize = function (profile: StoredProfile): ProfileSummary {
	return {
		id: profile.id,
		name: profile.name,
		hasSave: profile.save !== undefined,
		savedAt: profile.save === undefined ? null : getSavedAt(profile.save),
		hasCampaignSave: profile.campaignSave !== undefined,
		campaignSavedAt: profile.campaignSave === undefined ? null : getSavedAt(profile.campaignSave),
	};
};
const errorMessage = function (error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return 'Browser storage could not complete the request.';
};

export class ProfileRepository {
	private readonly pendingWrites = new Map<string, Promise<void>>();

	constructor(private readonly database: ProfileDatabase) {}

	async listProfiles(): Promise<ProfileSummary[]> {
		try {
			const profiles = (await this.database.listProfiles()).map(parseStoredProfile);
			return profiles
				.map(summarize)
				.sort(function (a, b) {
					return a.name.localeCompare(b.name);
				});
		} catch (error) {
			throw this.storageFailure('Profiles could not be read', error);
		}
	}

	async createProfile(name: string): Promise<ProfileSummary> {
		const profile: StoredProfile = {
			id: crypto.randomUUID(),
			name: normalizeProfileName(name),
		};
		try {
			await this.database.createProfile(profile, MAX_PROFILES);
			return summarize(profile);
		} catch (error) {
			if (error instanceof ProfileLimitError) throw error;
			throw this.storageFailure('The new profile could not be created', error);
		}
	}

	async renameProfile(id: string, name: string): Promise<void> {
		const cleanName = normalizeProfileName(name);
		const database = this.database;
		await this.enqueueWrite(id, function () {
			return database.updateProfile(id, function (profile) {
				return { ...profile, name: cleanName };
			});
		});
	}

	async deleteProfile(id: string): Promise<void> {
		const database = this.database;
		await this.enqueueWrite(id, function () {
			return database.deleteProfile(id);
		});
	}

	async loadSave(id: string): Promise<ConquestSave | undefined> {
		try {
			const raw = await this.database.getProfile(id);
			if (raw === undefined) throw new ProfileNotFoundError();
			const profile = parseStoredProfile(raw);
			if (profile.save === undefined) return undefined;
			return parseConquestSave(profile.save, id);
		} catch (error) {
			if (error instanceof InvalidSaveError || error instanceof ProfileNotFoundError)
				throw error;
			throw this.storageFailure('The saved conquest could not be read', error);
		}
	}

	async saveProfile(input: ConquestSave): Promise<void> {
		const save = structuredClone(parseConquestSave(input, input.profileId));
		const database = this.database;
		await this.enqueueWrite(save.profileId, function () {
			return database.updateProfile(save.profileId, function (profile) {
				return { ...profile, save };
			});
		});
	}

	async loadCampaignSave(id: string): Promise<CampaignSave | undefined> {
		try {
			const raw = await this.database.getProfile(id);
			if (raw === undefined) throw new ProfileNotFoundError();
			const profile = parseStoredProfile(raw);
			if (profile.campaignSave === undefined) return undefined;
			return parseCampaignSave(profile.campaignSave, id);
		} catch (error) {
			if (error instanceof InvalidSaveError || error instanceof ProfileNotFoundError)
				throw error;
			throw this.storageFailure('The saved campaign could not be read', error);
		}
	}

	async saveCampaign(input: CampaignSave): Promise<void> {
		const campaignSave = structuredClone(parseCampaignSave(input, input.profileId));
		const database = this.database;
		await this.enqueueWrite(campaignSave.profileId, function () {
			return database.updateProfile(campaignSave.profileId, function (profile) {
				return { ...profile, campaignSave };
			});
		});
	}

	async getSelectedProfileId(): Promise<string | null> {
		try {
			const value = await this.database.getSelectedProfileId();
			return isProfileId(value) ? value : null;
		} catch (error) {
			throw this.storageFailure('The selected profile could not be read', error);
		}
	}

	async setSelectedProfileId(id: string | null): Promise<void> {
		try {
			await this.database.setSelectedProfileId(id);
		} catch (error) {
			throw this.storageFailure('The selected profile could not be saved', error);
		}
	}

	close(): void {
		this.database.close();
	}

	private enqueueWrite(id: string, action: () => Promise<void>): Promise<void> {
		const previous = this.pendingWrites.get(id) ?? Promise.resolve();
		const current = previous.catch(function () {}).then(action);
		this.pendingWrites.set(id, current);
		const pendingWrites = this.pendingWrites;
		const clear = function (): void {
			if (pendingWrites.get(id) === current) pendingWrites.delete(id);
		};
		void current.then(clear, clear);
		const storageFailure = this.storageFailure.bind(this);
		return current.catch(function (error: unknown) {
			if (error instanceof ProfileNotFoundError) throw error;
			throw storageFailure('The profile could not be updated', error);
		});
	}

	private storageFailure(action: string, error: unknown): ProfileStorageError {
		if (error instanceof ProfileStorageError) return error;
		return new ProfileStorageError(`${action}: ${errorMessage(error)}`);
	}
}

interface LocalProfileDatabase extends DBSchema {
	profiles: { key: string; value: unknown };
	settings: { key: string; value: unknown };
}
type ProfileStoreName = typeof PROFILE_STORE | typeof SETTINGS_STORE;
type ProfileTransaction<Mode extends IDBTransactionMode = IDBTransactionMode> = IDBPTransaction<
	LocalProfileDatabase,
	ProfileStoreName[],
	Mode
>;

class IndexedDbProfileDatabase implements ProfileDatabase {
	private constructor(private readonly database: IDBPDatabase<LocalProfileDatabase>) {}

	static open(): Promise<IndexedDbProfileDatabase> {
		return new Promise(function (resolve, reject) {
			let settled = false;
			let opening: Promise<IDBPDatabase<LocalProfileDatabase>>;
			try {
				opening = openDB<LocalProfileDatabase>(DATABASE_NAME, DATABASE_VERSION, {
					upgrade(database): void {
						if (!database.objectStoreNames.contains(PROFILE_STORE))
							database.createObjectStore(PROFILE_STORE, { keyPath: 'id' });
						if (!database.objectStoreNames.contains(SETTINGS_STORE))
							database.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
					},
					blocked() {
						if (settled) return;
						settled = true;
						reject(
							new ProfileStorageError(
								'Browser storage is busy in another game tab. Close the other tab and reload.',
							),
						);
					},
				});
			} catch (error) {
				reject(new ProfileStorageError(errorMessage(error)));
				return;
			}
			void opening.then(
				function (database) {
					if (settled) {
						database.close();
						return;
					}
					settled = true;
					database.onversionchange = function (): void {
						database.close();
					};
					resolve(new IndexedDbProfileDatabase(database));
				},
				function (error: unknown) {
					if (settled) return;
					settled = true;
					reject(
						new ProfileStorageError(
							`Browser storage could not open this game's database: ${errorMessage(error)}`,
						),
					);
				},
			);
		});
	}

	listProfiles(): Promise<unknown[]> {
		return this.runTransaction([PROFILE_STORE], 'readonly', function (transaction) {
			return transaction.objectStore(PROFILE_STORE).getAll();
		});
	}

	getProfile(id: string): Promise<unknown> {
		return this.runTransaction([PROFILE_STORE], 'readonly', function (transaction) {
			return transaction.objectStore(PROFILE_STORE).get(id);
		});
	}

	createProfile(profile: StoredProfile, maximum: number): Promise<void> {
		return this.runTransaction([PROFILE_STORE], 'readwrite', async function (transaction) {
			const store = transaction.objectStore(PROFILE_STORE);
			if ((await store.count()) >= maximum) throw new ProfileLimitError();
			await store.add(profile);
		});
	}

	updateProfile(
		id: string,
		update: (profile: StoredProfile) => StoredProfile,
	): Promise<void> {
		return this.runTransaction([PROFILE_STORE], 'readwrite', async function (transaction) {
			const store = transaction.objectStore(PROFILE_STORE);
			const value = await store.get(id);
			if (value === undefined) throw new ProfileNotFoundError();
			const next = update(parseStoredProfile(value));
			if (next.id !== id) throw new ProfileStorageError('Profile IDs cannot change.');
			await store.put(next);
		});
	}

	deleteProfile(id: string): Promise<void> {
		return this.runTransaction(
			[PROFILE_STORE, SETTINGS_STORE],
			'readwrite',
			async function (transaction) {
				const profiles = transaction.objectStore(PROFILE_STORE);
				const settings = transaction.objectStore(SETTINGS_STORE);
				if ((await profiles.get(id)) === undefined) throw new ProfileNotFoundError();
				const selection = await settings.get(SELECTED_PROFILE_KEY);
				await profiles.delete(id);
				if (
					isRecord(selection) &&
					selection.key === SELECTED_PROFILE_KEY &&
					selection.value === id
				)
					await settings.delete(SELECTED_PROFILE_KEY);
			},
		);
	}

	getSelectedProfileId(): Promise<unknown> {
		return this.runTransaction([SETTINGS_STORE], 'readonly', async function (transaction) {
			const selection = await transaction
				.objectStore(SETTINGS_STORE)
				.get(SELECTED_PROFILE_KEY);
			return isRecord(selection) && selection.key === SELECTED_PROFILE_KEY
				? selection.value
				: null;
		});
	}

	setSelectedProfileId(id: string | null): Promise<void> {
		return this.runTransaction(
			[PROFILE_STORE, SETTINGS_STORE],
			'readwrite',
			async function (transaction) {
				const settings = transaction.objectStore(SETTINGS_STORE);
				if (id === null) {
					await settings.delete(SELECTED_PROFILE_KEY);
					return;
				}
				if ((await transaction.objectStore(PROFILE_STORE).get(id)) === undefined)
					throw new ProfileNotFoundError();
				await settings.put({ key: SELECTED_PROFILE_KEY, value: id });
			},
		);
	}

	close(): void {
		this.database.close();
	}

	private runTransaction<T, Mode extends IDBTransactionMode>(
		stores: ProfileStoreName[],
		mode: Mode,
		operation: (transaction: ProfileTransaction<Mode>) => Promise<T>,
	): Promise<T> {
		let transaction: ProfileTransaction<Mode>;
		try {
			transaction = this.database.transaction(stores, mode);
		} catch (error) {
			return Promise.reject(new ProfileStorageError(errorMessage(error)));
		}
		return this.commitTransaction(transaction, operation);
	}

	private async commitTransaction<T, Mode extends IDBTransactionMode>(
		transaction: ProfileTransaction<Mode>,
		operation: (transaction: ProfileTransaction<Mode>) => Promise<T>,
	): Promise<T> {
		const completion = transaction.done.then(
			function () {
				return { succeeded: true as const };
			},
			function (error: unknown) {
				return { succeeded: false as const, error };
			},
		);
		try {
			const result = await operation(transaction);
			const outcome = await completion;
			if (!outcome.succeeded) throw outcome.error;
			return result;
		} catch (error) {
			try {
				transaction.abort();
			} catch {
				// A transaction can already have aborted after an IndexedDB request failed.
			}
			await completion;
			throw error;
		}
	}
}

export const openProfileRepository = async function (): Promise<ProfileRepository> {
	if (typeof indexedDB === 'undefined')
		throw new ProfileStorageError(
			'IndexedDB is unavailable. Open Galaxy Conquest in a regular browser tab to use local profiles.',
		);
	return new ProfileRepository(await IndexedDbProfileDatabase.open());
};
