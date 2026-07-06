import { folderMapReduceRecipe } from './recipes/folder-map-reduce.js';
import { officeTeamRecipe } from './recipes/office-team.js';
import { pptFromFolderRecipe } from './recipes/ppt-from-folder.js';
import { weeklyReportRecipe } from './recipes/weekly-report.js';
import type { OrchestrationRecipe } from './workflow-types.js';

export const ORCHESTRATION_RECIPE_IDS = ['weekly-report', 'folder-map-reduce', 'office-team', 'ppt-from-folder'] as const;
export type OrchestrationRecipeId = typeof ORCHESTRATION_RECIPE_IDS[number];
export type OrchestrationRunnerKind = 'deterministic' | 'subagent' | 'provider';

type RecipeDefinition = {
  recipe: OrchestrationRecipe;
  runnerKind: OrchestrationRunnerKind;
};

const DEFINITIONS: Record<OrchestrationRecipeId, RecipeDefinition> = {
  'weekly-report': { recipe: weeklyReportRecipe, runnerKind: 'deterministic' },
  'folder-map-reduce': { recipe: folderMapReduceRecipe, runnerKind: 'subagent' },
  'office-team': { recipe: officeTeamRecipe, runnerKind: 'subagent' },
  'ppt-from-folder': { recipe: pptFromFolderRecipe, runnerKind: 'subagent' },
};

export function getOrchestrationRecipeDefinition(recipeId: OrchestrationRecipeId): RecipeDefinition {
  return DEFINITIONS[recipeId];
}

export function listOrchestrationRecipeDefinitions(): RecipeDefinition[] {
  return ORCHESTRATION_RECIPE_IDS.map((id) => getOrchestrationRecipeDefinition(id));
}
