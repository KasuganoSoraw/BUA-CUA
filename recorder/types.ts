export type RecorderActionType =
  | 'click'
  | 'input'
  | 'select'
  | 'keypress'
  | 'navigation'
  | 'unknown';

export type SelectorCandidateKind = 'role' | 'label' | 'text' | 'testId' | 'css';

export type RectEvidence = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PointerEvidence = {
  x: number;
  y: number;
  coordinateSpace: 'viewport';
};

export type TargetEvidence = {
  tagName?: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  labelText?: string;
  id?: string;
  className?: string;
  name?: string;
  type?: string;
  valueSummary?: string;
  boundingBox?: RectEvidence;
};

export type SelectorCandidate = {
  kind: SelectorCandidateKind;
  value: string;
  confidence: number;
  reason: string;
};

export type ElementStackItem = {
  tagName: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  id?: string;
  className?: string;
  name?: string;
  type?: string;
  boundingBox?: RectEvidence;
};

export type DomEvidence = {
  elementStack: ElementStackItem[];
  nearbyText: string[];
  formContext?: Record<string, unknown>;
  tableContext?: Record<string, unknown>;
  dialogContext?: Record<string, unknown>;
};

export type ActionScreenshots = {
  beforeViewport: string;
  afterViewport?: string;
};

export type StateDelta = {
  urlChanged: boolean;
  titleChanged: boolean;
  focusedElementChanged: boolean;
  dialogAppeared: boolean;
  visibleTextAdded: string[];
  visibleTextRemoved: string[];
};

export type ActionRecord = {
  id: string;
  type: RecorderActionType;
  timestamp: string;
  urlBefore: string;
  urlAfter?: string;
  titleBefore?: string;
  titleAfter?: string;
  viewport: {
    width: number;
    height: number;
  };
  pointer?: PointerEvidence;
  target?: TargetEvidence;
  selectorCandidates: SelectorCandidate[];
  domEvidence: DomEvidence;
  screenshots: ActionScreenshots;
  stateDelta?: StateDelta;
};

export type RecordingIndexAction = {
  id: string;
  type: RecorderActionType;
  timestamp: string;
  actionFile: string;
  beforeViewport: string;
  afterViewport?: string;
  urlBefore: string;
  urlAfter?: string;
  targetSummary?: string;
};

export type RecordingIndex = {
  schemaVersion: 1;
  taskName: string;
  startUrl: string;
  startedAt: string;
  endedAt?: string;
  browser: 'chromium';
  viewport: {
    width: number;
    height: number;
  };
  actions: RecordingIndexAction[];
};
