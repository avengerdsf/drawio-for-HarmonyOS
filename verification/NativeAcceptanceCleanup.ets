import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileShare, fileUri } from '@kit.CoreFileKit';
import preferences from '@ohos.data.preferences';

const OWNED_PATH: string = '/storage/Users/currentUser/Download/drawio-test-tmp';
const OWNED_URI: string = 'file://docs/storage/Users/currentUser/Download/drawio-test-tmp';
const KEYS: string[] = ['persistedFileUris', 'defaultDownloadUri'];

interface CleanupFailure {
  phase: string;
  uri: string;
  code: number;
  message: string;
  policyErrorCodes: number[];
}

interface CleanupPolicy {
  uri: string;
  operationMode: number;
  activated: boolean;
  revoked: boolean;
  cleared: boolean;
}

interface CleanupPreference {
  key: string;
  removed: string[];
  retainedCount: number;
}

export interface AcceptanceCleanupResult {
  operation: string;
  success: boolean;
  readyForNode: boolean;
  directory: string;
  directoryUri: string;
  expectedNames: string[];
  policies: CleanupPolicy[];
  preferences: CleanupPreference[];
  preferencesFlushed: boolean;
  failures: CleanupFailure[];
  filesystemModified: boolean;
}

export default class NativeAcceptanceCleanup {
  private static candidates: string[] = [];

  private static result(operation: string): AcceptanceCleanupResult {
    return { operation: operation, success: false, readyForNode: false,
      directory: OWNED_PATH, directoryUri: OWNED_URI, expectedNames: [], policies: [],
      preferences: [], preferencesFlushed: false, failures: [], filesystemModified: false };
  }

  private static failure(phase: string, uri: string, error: Error): CleanupFailure {
    const detail: BusinessError<Array<fileShare.PolicyErrorResult>> =
      error as BusinessError<Array<fileShare.PolicyErrorResult>>;
    const codes: number[] = [];
    if (detail.data !== undefined) {
      for (const policy of detail.data) {
        codes.push(policy.code);
      }
    }
    return { phase: phase, uri: uri, code: detail.code || -1,
      message: detail.message || 'Unknown cleanup error', policyErrorCodes: codes };
  }

  private static inPreferenceScope(uri: string): boolean {
    return uri === OWNED_URI || uri.startsWith(OWNED_URI + '/');
  }

  private static inPolicyScope(uri: string): boolean {
    if (!NativeAcceptanceCleanup.inPreferenceScope(uri)) {
      return false;
    }
    try {
      const path: string = new fileUri.FileUri(uri).path;
      return (path === OWNED_PATH || path.startsWith(OWNED_PATH + '/')) &&
        path.indexOf('\0') === -1 && !path.split('/').includes('..') && !path.split('/').includes('.');
    } catch (error) {
      return false;
    }
  }

  private static readUris(store: preferences.Preferences, key: string): string[] {
    const raw = store.getSync(key, '[]');
    if (typeof raw !== 'string') {
      throw new Error('Unexpected cleanup preference type: ' + key);
    }
    const values: string[] = JSON.parse(raw) as string[];
    if (!Array.isArray(values)) {
      throw new Error('Cleanup preference is not a URI array: ' + key);
    }
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new Error('Cleanup preference has a non-string URI: ' + key);
      }
    }
    return values;
  }

  private static collect(store: preferences.Preferences, expectedNames: string[]): string[] {
    const uris: string[] = [OWNED_URI];
    for (const name of expectedNames) {
      uris.push(OWNED_URI + '/' + encodeURIComponent(name));
    }
    for (const key of KEYS) {
      for (const uri of NativeAcceptanceCleanup.readUris(store, key)) {
        if (NativeAcceptanceCleanup.inPreferenceScope(uri) && !uris.includes(uri)) {
          uris.push(uri);
        }
      }
    }
    return uris;
  }

  private static async mode(uri: string): Promise<number> {
    const readWrite: number = fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE;
    const policy: fileShare.PolicyInfo = { uri: uri, operationMode: readWrite };
    const combined: boolean[] = await fileShare.checkPersistentPermission([policy]);
    if (combined.length !== 1) {
      throw new Error('Unexpected persistent permission result');
    }
    if (combined[0]) {
      return readWrite;
    }
    policy.operationMode = fileShare.OperationMode.READ_MODE;
    const read: boolean[] = await fileShare.checkPersistentPermission([policy]);
    if (read.length !== 1) {
      throw new Error('Unexpected read permission result');
    }
    return read[0] ? fileShare.OperationMode.READ_MODE : 0;
  }

  static async prepare(context: common.Context, expectedNames: string[]): Promise<AcceptanceCleanupResult> {
    const result: AcceptanceCleanupResult = NativeAcceptanceCleanup.result('prepare');
    try {
      if (!Array.isArray(expectedNames)) {
        throw new Error('Cleanup names must be an array');
      }
      for (const name of expectedNames) {
        if (typeof name !== 'string' || name.trim().length === 0 || name === '.' || name === '..' ||
          name.indexOf('/') !== -1 || name.indexOf('\\') !== -1 || name.indexOf('\0') !== -1) {
          throw new Error('Cleanup names must contain only nonempty basenames');
        }
        if (!result.expectedNames.includes(name)) {
          result.expectedNames.push(name);
        }
      }
      const store: preferences.Preferences = preferences.getPreferencesSync(context, { name: 'myStore' });
      const candidates: string[] = NativeAcceptanceCleanup.collect(store, result.expectedNames);
      NativeAcceptanceCleanup.candidates = candidates;
      for (const uri of candidates) {
        try {
          if (!NativeAcceptanceCleanup.inPolicyScope(uri)) {
            throw new Error('Owned policy URI has an invalid or escaping path');
          }
          const operationMode: number = await NativeAcceptanceCleanup.mode(uri);
          const record: CleanupPolicy = { uri: uri, operationMode: operationMode,
            activated: false, revoked: false, cleared: operationMode === 0 };
          result.policies.push(record);
          if (operationMode !== 0) {
            await fileShare.activatePermission([{ uri: uri, operationMode: operationMode }]);
            record.activated = true;
            if (uri === OWNED_URI && operationMode === 3) {
              result.readyForNode = true;
            }
          }
        } catch (error) {
          result.failures.push(NativeAcceptanceCleanup.failure('activate', uri, error as Error));
        }
      }
      result.success = result.readyForNode && result.failures.length === 0;
    } catch (error) {
      result.failures.push(NativeAcceptanceCleanup.failure('prepare', '', error as Error));
    }
    return result;
  }

  // The caller invokes finalize only after its nonrecursive Node cleanup succeeds.
  static async finalize(context: common.Context): Promise<AcceptanceCleanupResult> {
    const result: AcceptanceCleanupResult = NativeAcceptanceCleanup.result('finalize');
    try {
      const store: preferences.Preferences = preferences.getPreferencesSync(context, { name: 'myStore' });
      const candidates: string[] = NativeAcceptanceCleanup.collect(store, []);
      for (const uri of NativeAcceptanceCleanup.candidates) {
        if (!candidates.includes(uri)) {
          candidates.push(uri);
        }
      }
      for (const uri of candidates) {
        try {
          if (!NativeAcceptanceCleanup.inPolicyScope(uri)) {
            throw new Error('Owned policy URI has an invalid or escaping path');
          }
          const operationMode: number = await NativeAcceptanceCleanup.mode(uri);
          const record: CleanupPolicy = { uri: uri, operationMode: operationMode,
            activated: false, revoked: false, cleared: operationMode === 0 };
          result.policies.push(record);
          if (operationMode !== 0) {
            await fileShare.revokePermission([{ uri: uri, operationMode: operationMode }]);
            record.revoked = true;
            record.cleared = await NativeAcceptanceCleanup.mode(uri) === 0;
            if (!record.cleared) {
              throw new Error('Owned policy is still persisted after revocation');
            }
          }
        } catch (error) {
          result.failures.push(NativeAcceptanceCleanup.failure('revoke', uri, error as Error));
        }
      }
      for (const key of KEYS) {
        const current: string[] = NativeAcceptanceCleanup.readUris(store, key);
        const kept: string[] = current.filter((uri: string) => !NativeAcceptanceCleanup.inPreferenceScope(uri));
        const removed: string[] = current.filter((uri: string) => NativeAcceptanceCleanup.inPreferenceScope(uri));
        result.preferences.push({ key: key, removed: removed, retainedCount: kept.length });
        if (removed.length > 0) {
          store.putSync(key, JSON.stringify(kept));
        }
      }
      await store.flush();
      result.preferencesFlushed = true;
      result.success = result.failures.length === 0 && result.policies.every((policy: CleanupPolicy) => policy.cleared);
      NativeAcceptanceCleanup.candidates = [];
    } catch (error) {
      result.failures.push(NativeAcceptanceCleanup.failure('finalize', '', error as Error));
    }
    return result;
  }
}
