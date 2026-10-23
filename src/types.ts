export type Category = "pothole" | "gravel" | "oil" | "obstacle" | "closure";
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
  source: "community" | "demo";
};
export type NewReport = Pick<
  Report,
  | "category"
  | "latitude"
  | "longitude"
  | "location"
  | "description"
  | "severity"
>;
