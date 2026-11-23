local M = {}
M.values = {
  executable = "schlop",
  -- Draw Markdown surfaces rendered in place; `R` shows the raw source.
  render_markdown = true,
  mappings = {
    annotate = "c",
    edit = "e",
    delete = "d",
    inspected = "m",
    next_annotation = "]a",
    previous_annotation = "[a",
    next_document = "]f",
    previous_document = "[f",
    submit = "s",
    cancel = "q",
    interrupt = "<C-c>",
    help = "?",
    toggle_rendered = "R",
  },
}
function M.setup(options)
  M.values = vim.tbl_deep_extend("force", M.values, options or {})
end
return M
