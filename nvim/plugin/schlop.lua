if vim.g.loaded_schlop == 1 then return end
vim.g.loaded_schlop = 1
local function split(value) return value == "" and {} or vim.fn.split(value) end
vim.api.nvim_create_user_command("SchlopDiff", function(options) require("schlop").diff(split(options.args)) end, { nargs = "*" })
vim.api.nvim_create_user_command("SchlopFile", function(options)
  local args = split(options.args)
  if not args[1] then error("SchlopFile requires a path") end
  require("schlop").file(args[1], args[2])
end, { nargs = "+", complete = "file" })
vim.api.nvim_create_user_command("SchlopRequest", function(options) require("schlop").open_request(options.args) end, { nargs = 1, complete = "file" })
vim.api.nvim_create_user_command("SchlopResume", function(options) require("schlop").resume(options.args ~= "" and options.args or nil) end, { nargs = "?" })
vim.api.nvim_create_user_command("SchlopSubmit", function() require("schlop").submit() end, {})
vim.api.nvim_create_user_command("SchlopCancel", function() require("schlop").cancel() end, {})
