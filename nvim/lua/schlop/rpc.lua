local M = {}
local next_id = 0
local pending = {}
local job
local stopping = false
local errors = {}
local stdout_fragment = ""

local function notify(message, level)
  vim.schedule(function() vim.notify("Schlop: " .. message, level or vim.log.levels.ERROR) end)
end

function M.start(launch_path, on_ready)
  if job then error("a Schlop controller is already running") end
  stopping = false
  errors = {}
  stdout_fragment = ""
  local encoded = vim.env.SCHLOP_CONTROLLER_COMMAND
  local command
  if encoded and encoded ~= "" then
    local ok, value = pcall(vim.json.decode, encoded)
    if ok and type(value) == "table" then command = value end
  end
  if not command then command = { require("schlop.config").values.executable } end
  table.insert(command, "__controller")
  table.insert(command, launch_path)
  job = vim.fn.jobstart(command, {
    stdout_buffered = false,
    stderr_buffered = false,
    on_stdout = function(_, lines)
      if not lines or #lines == 0 then return end
      lines[1] = stdout_fragment .. lines[1]
      stdout_fragment = table.remove(lines) or ""
      for _, line in ipairs(lines) do
        if line ~= "" then
          local ok, response = pcall(vim.json.decode, line)
          if ok and response.id and pending[response.id] then
            local callback = pending[response.id]
            pending[response.id] = nil
            vim.schedule(function() callback(response.error, response.result) end)
          elseif not ok then notify("invalid controller response") end
        end
      end
    end,
    on_stderr = function(_, lines)
      for _, line in ipairs(lines or {}) do if line ~= "" then table.insert(errors, line) end end
    end,
    on_exit = function(_, code)
      local message = "controller exited " .. code .. (next(errors) and (": " .. table.concat(errors, " ")) or "")
      if code ~= 0 and not stopping then notify(message) end
      job = nil
      local callbacks = pending
      pending = {}
      local intentional = stopping
      stopping = false
      if intentional then return end
      for _, callback in pairs(callbacks) do
        local waiting = callback
        vim.schedule(function() waiting({ code = "CONTROLLER_EXIT", message = message }, nil) end)
      end
    end,
  })
  if job <= 0 then error("could not start Schlop controller") end
  M.call("getSession", {}, on_ready)
end

function M.call(method, params, callback)
  if not job then return notify("controller is not running") end
  next_id = next_id + 1
  pending[next_id] = callback or function(err) if err then notify(err.message) end end
  vim.fn.chansend(job, vim.json.encode({ id = next_id, method = method, params = params or {} }) .. "\n")
end

function M.stop()
  if job then stopping = true; vim.fn.jobstop(job); job = nil end
end
return M
