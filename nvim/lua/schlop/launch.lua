local M = {}

function M.start()
  local launch = vim.env.SCHLOP_LAUNCH
  if not launch or launch == "" then
    vim.api.nvim_err_writeln("Schlop startup failed: SCHLOP_LAUNCH is required")
    vim.cmd("cquit 1")
    return
  end
  local ok, err = pcall(require("schlop")._standalone, launch)
  if not ok then
    vim.api.nvim_err_writeln("Schlop startup failed: " .. tostring(err))
    vim.cmd("cquit 1")
  end
end

return M
