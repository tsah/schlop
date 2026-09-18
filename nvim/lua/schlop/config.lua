local M = {}
M.values = {
  executable = "schlop",
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
    approve = "S",
    cancel = "q",
    interrupt = "<C-c>",
    help = "?",
  },
}
function M.setup(options)
  M.values = vim.tbl_deep_extend("force", M.values, options or {})
end
return M
