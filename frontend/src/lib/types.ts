import type {
  AgentId,
  BuiltInAgentId,
  LinkedLinearIssue,
  OneshotConfig,
  PrEntry,
  ServiceStatus,
  WorktreeCreationPhase,
  WorktreeSource,
  WorktreeTab,
} from "@webmux/api-contract";

export type {
  AgentsUiConversationEvent,
  AgentsUiConversationMessage,
  AgentsUiConversationMessageDeltaEvent,
  AgentsUiConversationMessageUpsertEvent,
  AgentsUiConversationStatusEvent,
  AgentsUiConversationState,
  AgentsUiInterruptResponse,
  AgentsUiSendMessageResponse,
  AgentsUiWorktreeConversationResponse,
  AgentCapabilities,
  AgentDetails,
  AgentId,
  AgentKind,
  BuiltInAgentId,
  AgentListResponse,
  AgentResponse,
  AgentSummary,
  ValidateCustomAgentResponse,
  AppConfig,
  AppNotification,
  AvailableBranch,
  AvailableBranchesQuery,
  BranchListResponse,
  CiCheck,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  LinearIssue,
  LinearIssueAvailability,
  LinearIssueLabel,
  LinearIssueState,
  LinearIssuesResponse,
  LinkedLinearIssue,
  LinkedRepoInfo,
  OneshotConfig,
  PostWorktreeToLinearRequest,
  PostWorktreeToLinearResponse,
  PostWorktreeToLinearTarget,
  FromLinearInput,
  InstanceSummary,
  PrComment,
  PrEntry,
  ProfileConfig,
  ProjectInitPhase,
  ProjectInitState,
  ProjectSnapshot,
  ProjectSummary,
  ProjectWorktreeSnapshot,
  PullMainResult,
  RecoverDirectSwitchRequest,
  RecoverDirectSwitchResponse,
  ServiceConfig,
  UpsertCustomAgentRequest,
  ServiceStatus,
  SetWorktreeArchivedRequest,
  SetWorktreeArchivedResponse,
  SetWorktreeLabelRequest,
  SetWorktreeLabelResponse,
  PushPublicKeyResponse,
  PushSubscribeRequest,
  UnpushedCommit,
  VersionCheckResponse,
  WorktreeCreationPhase,
  WorktreeCreationState,
  WorktreeCreateMode,
  WorktreeDiffResponse,
  WorktreeListResponse,
  WorktreeSource,
  WorktreeTab,
} from "@webmux/api-contract";
export type { AgentsSendMessageRequest as AgentsUiSendMessageRequest } from "@webmux/api-contract";

export interface FileUploadResult {
  files: Array<{ path: string }>;
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
}

export interface DiffDialogProps {
  branch: string;
  cursorUrl?: string | null;
  onclose: () => void;
}

export interface WorktreeInfo {
  branch: string;
  label: string | null;
  baseBranch?: string;
  archived: boolean;
  agent: string;
  mux: string;
  path: string;
  dir: string | null;
  dirty: boolean;
  unpushed: boolean;
  status: string;
  elapsed: string;
  profile: string | null;
  agentName: AgentId | null;
  agentLabel: string | null;
  agentTerminalStale: boolean;
  services: ServiceStatus[];
  paneCount: number;
  prs: PrEntry[];
  linearIssue: LinkedLinearIssue | null;
  creating: boolean;
  creationPhase: WorktreeCreationPhase | null;
  source: WorktreeSource;
  oneshot: OneshotConfig | null;
  tabs: WorktreeTab[];
  activeTabId: string | null;
  /** True when this session runs directly on the main repo's own working
   *  directory (mode "direct") instead of a separate `git worktree`. */
  direct: boolean;
}

export interface WorktreeListRow {
  worktree: WorktreeInfo;
  depth: number;
  parentBranch: string | null;
}

export type ToastTone = "info" | "success" | "error";

export interface ToastInput {
  tone: ToastTone;
  message: string;
  detail?: string;
}

export interface UiToastItem extends ToastInput {
  id: string;
  source: "ui";
}

export interface NotificationToastItem extends ToastInput {
  id: string;
  source: "notification";
  notificationId: number;
  branch: string;
}

export type ToastItem = UiToastItem | NotificationToastItem;
