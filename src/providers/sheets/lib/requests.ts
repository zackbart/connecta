export const SHEETS_REQUEST_KINDS = [
  "addBanding",
  "addChart",
  "addCommentReply",
  "addConditionalFormatRule",
  "addDataSource",
  "addDimensionGroup",
  "addFilterView",
  "addNamedRange",
  "addProtectedRange",
  "addSheet",
  "addSlicer",
  "addTable",
  "appendCells",
  "appendDimension",
  "autoFill",
  "autoResizeDimensions",
  "cancelDataSourceRefresh",
  "clearBasicFilter",
  "copyPaste",
  "createDeveloperMetadata",
  "cutPaste",
  "deleteBanding",
  "deleteComment",
  "deleteCommentReply",
  "deleteConditionalFormatRule",
  "deleteDataSource",
  "deleteDeveloperMetadata",
  "deleteDimension",
  "deleteDimensionGroup",
  "deleteDuplicates",
  "deleteEmbeddedObject",
  "deleteFilterView",
  "deleteNamedRange",
  "deleteProtectedRange",
  "deleteRange",
  "deleteSheet",
  "deleteTable",
  "duplicateFilterView",
  "duplicateSheet",
  "findReplace",
  "insertComment",
  "insertDimension",
  "insertRange",
  "mergeCells",
  "moveDimension",
  "pasteData",
  "randomizeRange",
  "refreshDataSource",
  "repeatCell",
  "setBasicFilter",
  "setDataValidation",
  "sortRange",
  "textToColumns",
  "trimWhitespace",
  "unmergeCells",
  "updateBanding",
  "updateBorders",
  "updateCells",
  "updateChartSpec",
  "updateCommentPost",
  "updateConditionalFormatRule",
  "updateDataSource",
  "updateDeveloperMetadata",
  "updateDimensionGroup",
  "updateDimensionProperties",
  "updateEmbeddedObjectBorder",
  "updateEmbeddedObjectPosition",
  "updateFilterView",
  "updateNamedRange",
  "updateProtectedRange",
  "updateSheetProperties",
  "updateSlicerSpec",
  "updateSpreadsheetProperties",
  "updateTable",
] as const;

export const SHEETS_REFUSED_KINDS: Readonly<Record<string, string>> = {
  addDataSource: "External data-source creation and execution are outside this connection.",
  updateDataSource: "External data-source configuration and execution are outside this connection.",
  deleteDataSource: "External data-source administration is outside this connection.",
  refreshDataSource: "External data-source execution is outside this connection.",
  cancelDataSourceRefresh: "External data-source execution is outside this connection.",
  insertComment: "Preview comment mutations require separate product review.",
  addCommentReply: "Preview comment mutations require separate product review.",
  updateCommentPost: "Preview comment mutations require separate product review.",
  deleteComment: "Preview comment mutations require separate product review.",
  deleteCommentReply: "Preview comment mutations require separate product review.",
};
export const SHEETS_ADMITTED_KINDS = SHEETS_REQUEST_KINDS.filter((kind) => !SHEETS_REFUSED_KINDS[kind]);

/** Creation and ordinary batch kinds must not smuggle external data-source configuration. */
export function sheetsExternalDataProblem(body: unknown): string | undefined {
  const stack = [body];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (!Array.isArray(value))
      for (const key of ["dataSources", "dataSourceSheetProperties", "dataSourceId"]) {
        if (Object.hasOwn(value, key))
          return "External data-source configuration and execution are outside this connection.";
      }
    stack.push(...Object.values(value));
  }
  return undefined;
}
