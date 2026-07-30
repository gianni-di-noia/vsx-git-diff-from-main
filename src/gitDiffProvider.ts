import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { FileItem, FolderItem } from './types';
import { Logger } from './logger';

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

    // Restore last selected base branch from workspace state
    this.baseBranch = context.workspaceState.get('gitDiff.baseBranch', 'main');
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Set the base branch for comparison
   */
  async setBaseBranch(branch: string): Promise<void> {
    this.baseBranch = branch;
    await this.context.workspaceState.update('gitDiff.baseBranch', branch);
    this.refresh();
  }

  /**
   * Get the current base branch
   */
  getBaseBranch(): string {
    return this.baseBranch;
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
