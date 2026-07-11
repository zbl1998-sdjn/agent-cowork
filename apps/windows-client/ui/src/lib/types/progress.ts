// 进度展示类型(UI · lib/types):供应用状态与 ProgressLine 组件共享。
import type { ProgressStatus } from '../app-logic';

export interface ProgressLineProps {
  status?: ProgressStatus;
  icon?: string;
  text: string;
  duration?: string;
}
