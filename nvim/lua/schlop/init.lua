local M = {}
local config = require("schlop.config")
local bootstrap = require("schlop.bootstrap")

function M.setup(options) config.setup(options) end
function M._standalone(launch_path) bootstrap.start(launch_path, { standalone = true }) end
function M.open_request(path) bootstrap.start({ schemaVersion = 1, input = { kind = "request", path = vim.fn.fnamemodify(path, ":p") } }) end
function M.annotate(options)
  vim.validate({ options = { options, "table" }, kind = { options.kind, "string" }, content = { options.content, "string" } })
  if not vim.tbl_contains({ "text", "markdown", "diff" }, options.kind) then error("kind must be text, markdown, or diff") end
  bootstrap.start({ schemaVersion = 1, input = { kind = "content", surfaceKind = options.kind, title = options.title or "Document", content = options.content, resultPath = options.result_path } })
end
function M.diff(args) bootstrap.start({ schemaVersion = 1, input = { kind = "diff", args = args or {} } }) end
function M.file(path, kind) bootstrap.start({ schemaVersion = 1, input = { kind = "file", path = vim.fn.fnamemodify(path, ":p"), type = kind } }) end
function M.resume(id) bootstrap.start({ schemaVersion = 1, input = { kind = "resume", id = id } }) end
function M.submit() require("schlop.ui").finish("submit") end
function M.approve() require("schlop.ui").finish("approve") end
function M.cancel() require("schlop.ui").finish("cancel") end
return M
