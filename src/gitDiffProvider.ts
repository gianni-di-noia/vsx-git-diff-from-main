import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { FileItem } from './types';
import { Logger } from './logger';

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
        // Root level - show the flat file list directly (no group node)
        Logger.log('[GitDiff] Getting root items');
        return this.getRootItems();
      }

      Logger.log(`[GitDiff] No children for element: ${element.label}`);
      return [];
    } catch (error) {
      Logger.error('[GitDiff] Error in getChildren', error);
      return [];
    }
  }

  /**
   * Get root level items (files with all changes, committed + uncommitted combined)
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
    return allFiles.map(file => this.createFileItem(file, 'all'));
  }

  /**
   * Create a file tree item
   */
  private createFileItem(filePath: string, section: 'all' | 'committed' | 'uncommitted'): FileItem {
    const fileName = path.basename(filePath);
    const fileUri = vscode.Uri.file(path.join(this.workspaceRoot, filePath));

    const fileItem = new FileItem(
      fileName,
      fileUri,
      vscode.TreeItemCollapsibleState.None,
      section,
      this.baseBranch,
      {
        command: 'gitDiff.openDiff',
        title: 'Open Diff',
        arguments: [{ resourceUri: fileUri, section, baseBranch: this.baseBranch }]
      }
    );

    // Set description to show relative path
    if (filePath.includes('/')) {
      fileItem.description = path.dirname(filePath);
    }

    // Set icon based on file type
    fileItem.iconPath = vscode.ThemeIcon.File;

    return fileItem;
  }
}
