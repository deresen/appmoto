export type { Category } from "../shared/reportRules";
import type { Category } from "../shared/reportRules";
export type Severity = "attention" | "danger";
export type Report = {
  id: string;
  category: Category;
  latitude: number;
  longitude: number;
  location: string;
  description: string;
  severity: Severity;
  createdAt: string;
  expiresAt: string;
  confirmations: number;
  confirmedByMe: boolean;
  clearVotes: number;
  clearedByMe: boolean;
  resolvedAt: string | null;
  source: "community" | "demo";
};
export type ReportFocusStatus = "active" | "resolved" | "expired" | "missing";
export type ReportsSnapshot = {
  reports: Report[];
  focusedReport?: Report | null;
  focusStatus?: ReportFocusStatus;
};
export type NewReport = Pick<
  Report,
  | "category"
  | "latitude"
  | "longitude"
  | "location"
  | "description"
  | "severity"
> & { allowDuplicate?: boolean };
