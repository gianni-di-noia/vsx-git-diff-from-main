import * as vscode from 'vscode';
import { Logger } from './logger';

/**
 * Minimal surface of the built-in `vscode.git` extension API that we rely on.
 * (The full type comes from the `vscode.git` extension's `git.d.ts`, which we
 * don't depend on directly.)
 */
export interface GitApiRepositoryUIState {
  /** True if this is the repository currently selected in the Source Control "Repositories" view */
  readonly selected: boolean;
  readonly onDidChange: vscode.Event<void>;
}

export interface GitApiRepository {
  rootUri: vscode.Uri;
  readonly ui: GitApiRepositoryUIState;
}

export interface GitApi {
  readonly repositories: GitApiRepository[];
  getRepository(uri: vscode.Uri): GitApiRepository | null;
  readonly onDidOpenRepository: vscode.Event<GitApiRepository>;
  readonly onDidCloseRepository: vscode.Event<GitApiRepository>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

let cachedApi: GitApi | undefined;

/**
 * Get the API exposed by VS Code's built-in `vscode.git` extension, which
 * knows about every repository discovered in the current workspace
 * (including nested repos in a multi-repo folder). Returns undefined if the
 * git extension isn't installed/enabled.
 */
export async function getBuiltinGitApi(): Promise<GitApi | undefined> {
  if (cachedApi) {
    return cachedApi;
  }

  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!extension) {
    Logger.log('[GitApi] vscode.git extension not found');
    return undefined;
  }

  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    cachedApi = exports.getAPI(1);
    return cachedApi;
  } catch (error) {
    Logger.error('[GitApi] Failed to activate vscode.git extension', error);
    return undefined;
  }
}
