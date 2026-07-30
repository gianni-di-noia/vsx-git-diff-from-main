import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { FileItem, FolderItem } from './types';
import { Logger } from './logger';
import { getBuiltinGitApi, GitApiRepository } from './gitApi';

const SELECTED_REPO_KEY = 'gitDiff.selectedRepo';

/**
 * Internal node used to build the folder/file tree from a flat list of paths
 */
interface TreeNode {
  name: string;
  fullPath: string;
  filePath?: string;
  children: Map<string, TreeNode>;
}

/**
 * Tree data provider for git diff sidebar
 */
export class GitDiffProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private _onDidChangeRepo: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
  readonly onDidChangeRepo: vscode.Event<string> = this._onDidChangeRepo.event;

  private gitService: GitService;
  private workspaceRoot: string;
  private baseBranch: string = 'main';

  // Children of each folder, keyed by the folder's relative path ('' = root); rebuilt on each root query
  private folderChildren: Map<string, vscode.TreeItem[]> = new Map();

  constructor(private context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      throw new Error('No workspace folder found');
    }
    this.workspaceRoot = workspaceFolders[0].uri.fsPath;
    this.gitService = new GitService(this.workspaceRoot);
    this.baseBranch = this.loadBaseBranch(this.workspaceRoot);
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Set the base branch for comparison (scoped to the currently active repo)
   */
  async setBaseBranch(branch: string): Promise<void> {
    this.baseBranch = branch;
    await this.context.workspaceState.update(this.baseBranchKey(this.workspaceRoot), branch);
    this.refresh();
  }

  /**
   * Get the current base branch
   */
  getBaseBranch(): string {
    return this.baseBranch;
  }

  /**
   * Get the root of the repository currently displayed
   */
  getCurrentRepoRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Get the GitService for the repository currently displayed
   */
  getGitService(): GitService {
    return this.gitService;
  }

  /**
   * List every git repository VS Code has discovered in this workspace
   * (including nested repos in a multi-repo folder)
   */
  async listRepositories(): Promise<GitApiRepository[]> {
    const gitApi = await getBuiltinGitApi();
    return gitApi?.repositories ?? [];
  }

  /**
   * Manually pin a repository as the one to display, overriding auto-detection
   */
  async selectRepository(repoRoot: string): Promise<void> {
    await this.context.workspaceState.update(SELECTED_REPO_KEY, repoRoot);
    await this.syncActiveRepo();
    this.refresh();
  }

  private baseBranchKey(repoRoot: string): string {
    return `gitDiff.baseBranch:${repoRoot}`;
  }

  private loadBaseBranch(repoRoot: string): string {
    return this.context.workspaceState.get(this.baseBranchKey(repoRoot), 'main');
  }

  /**
   * Work out which repository should be displayed and switch to it if needed:
   * 1. A repo the user explicitly pinned via `selectRepository`
   * 2. The repo containing the file open in the active editor
   * 3. The first repo VS Code discovered in the workspace
   * Falls back to the first workspace folder when the git extension/API is unavailable.
   */
  async syncActiveRepo(): Promise<boolean> {
    const gitApi = await getBuiltinGitApi();
    if (!gitApi || gitApi.repositories.length === 0) {
      return false;
    }

    const pinned = this.context.workspaceState.get<string>(SELECTED_REPO_KEY);
    let newRoot: string | undefined;

    if (pinned && gitApi.repositories.some(r => r.rootUri.fsPath === pinned)) {
      newRoot = pinned;
    } else {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const activeRepo = activeUri ? gitApi.getRepository(activeUri) : null;
      newRoot = activeRepo?.rootUri.fsPath ?? gitApi.repositories[0].rootUri.fsPath;
    }

    if (newRoot === this.workspaceRoot) {
      return false;
    }

    Logger.log(`[GitDiff] Switching active repository to ${newRoot}`);
    this.workspaceRoot = newRoot;
    this.gitService.setRoot(newRoot);
    this.baseBranch = this.loadBaseBranch(newRoot);
    this._onDidChangeRepo.fire(newRoot);
    return true;
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    try {
      if (!element) {
        // Root level - build the folder/file tree
        Logger.log('[GitDiff] Getting root items');
        return this.getRootItems();
      }

      if (element instanceof FolderItem) {
        return this.folderChildren.get(element.fullPath) ?? [];
      }

      Logger.log(`[GitDiff] No children for element: ${element.label}`);
      return [];
    } catch (error) {
      Logger.error('[GitDiff] Error in getChildren', error);
      return [];
    }
  }

  /**
   * Get root level items and rebuild the folder tree cache
   */
  private async getRootItems(): Promise<vscode.TreeItem[]> {
    await this.syncActiveRepo();

    Logger.log('[GitDiff] Getting root items, checking if git repo...');
    const isGitRepo = await this.gitService.isGitRepository();
    if (!isGitRepo) {
      Logger.log('[GitDiff] Not a git repository');
      const item = new vscode.TreeItem('Not a git repository');
      item.contextValue = 'error';
      return [item];
    }

    Logger.log(`[GitDiff] Getting all changes from ${this.baseBranch}`);
    const committedFiles = await this.gitService.getCommittedChanges(this.baseBranch);
    Logger.log(`[GitDiff] Committed files: ${committedFiles.length}`);
    const uncommittedFiles = await this.gitService.getUncommittedChanges();
    Logger.log(`[GitDiff] Uncommitted files: ${uncommittedFiles.length}`);

    // Combine and deduplicate
    const allFiles = [...new Set([...committedFiles, ...uncommittedFiles])];
    Logger.log(`[GitDiff] Total all changes: ${allFiles.length}`);

    return this.buildFolderTree(allFiles);
  }

  /**
   * Build a folder/file tree from a flat list of relative paths, caching each
   * folder's children so getChildren() can look them up by path.
   */
  private buildFolderTree(filePaths: string[]): vscode.TreeItem[] {
    this.folderChildren.clear();

    const root: TreeNode = { name: '', fullPath: '', children: new Map() };

    for (const filePath of filePaths) {
      const parts = filePath.split('/');
      let current = root;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        const fullPath = current.fullPath ? `${current.fullPath}/${part}` : part;
        let child = current.children.get(part);
        if (!child) {
          child = { name: part, fullPath, children: new Map() };
          current.children.set(part, child);
        }
        current = child;
      }

      const fileName = parts[parts.length - 1];
      current.children.set(`\0file:${fileName}`, {
        name: fileName,
        fullPath: filePath,
        filePath,
        children: new Map()
      });
    }

    return this.convertNodeChildren(root);
  }

  /**
   * Convert a TreeNode's children to sorted tree items (folders first, then files),
   * caching the result so it can be looked up later by folder path.
   */
  private convertNodeChildren(node: TreeNode): vscode.TreeItem[] {
    const folders: FolderItem[] = [];
    const files: FileItem[] = [];

    for (const child of node.children.values()) {
      if (child.filePath) {
        files.push(this.createFileItem(child.filePath));
      } else {
        const folderItem = new FolderItem(child.name, child.fullPath);
        this.folderChildren.set(child.fullPath, this.convertNodeChildren(child));
        folders.push(folderItem);
      }
    }

    folders.sort((a, b) => a.label.localeCompare(b.label));
    files.sort((a, b) => a.label.localeCompare(b.label));

    const items = [...folders, ...files];
    this.folderChildren.set(node.fullPath, items);
    return items;
  }

  /**
   * Create a file tree item
   */
  private createFileItem(filePath: string): FileItem {
    const fileName = path.basename(filePath);
    const fileUri = vscode.Uri.file(path.join(this.workspaceRoot, filePath));

    const fileItem = new FileItem(
      fileName,
      fileUri,
      vscode.TreeItemCollapsibleState.None,
      'all',
      this.baseBranch,
      {
        command: 'gitDiff.openDiff',
        title: 'Open Diff',
        arguments: [{ resourceUri: fileUri, section: 'all', baseBranch: this.baseBranch }]
      }
    );

    fileItem.iconPath = vscode.ThemeIcon.File;

    return fileItem;
  }
}
