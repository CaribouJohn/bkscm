"TODOs
"in file tagging matched_file should be checked against the changed file list
"provide undo for discard option
"make file status bitkeeper independant
"try to get filetype for new files in Diffs window
"temp files hang around after commiting new file
"don't lose comments and tags if commit fails

function! SetWindowAsTemp()
  silent! setlocal buftype=nofile
  silent! setlocal bufhidden=delete
  silent! setlocal noswapfile
endfunction

function! SetUpWindow()
  call SetWindowAsTemp()
  setlocal nomodifiable
  setlocal readonly
endfunction

let s:buffer_interface = {}

function! s:buffer_interface.construct(buffer_name) dict
  let self.winnr = bufwinnr('checkintool_' . a:buffer_name)
  let self.bufnr = bufnr('checkintool_' . a:buffer_name)
endfunction

function! s:buffer_interface.goto() dict
  exe self.winnr . "wincmd W"
endfunction

function! s:buffer_interface.start_write() dict
  setlocal modifiable
  setlocal noreadonly
endfunction

function! s:buffer_interface.goto_for_write() dict
  call self.goto()
  call self.start_write()
endfunction

function! s:buffer_interface.finish_write() dict
  setlocal nomodifiable
  setlocal readonly
endfunction

function! s:buffer_interface.close() dict
  if bufloaded(self.bufnr)
    exe ":bd" . self.bufnr 
  endif
endfunction

function! s:buffer_interface.persist() dict
endfunction

function! s:buffer_interface.load() dict
endfunction

let s:buffers_interface = {}
function! s:buffers_interface.construct(buffer_names) dict
  call map(a:buffer_names, 'self.add_entry(v:val)')
endfunction

function! s:buffers_interface.add_entry(buffer_name)
  let self[a:buffer_name] = deepcopy(s:buffer_interface)
  call self[a:buffer_name].construct(a:buffer_name)
endfunction

function! s:buffers_interface.close() dict
  function! s:Close(value)
    if type(a:value) == 4
      call a:value.close()
    endif
  endfunction
  call map(self, 's:Close(v:val)')
endfunction

let s:sc_access = {}

function! ConstructChangedFiles()
  let s:cit_buffers.ChangedFiles.persist_file = s:sc_access.getRoot() . '/' . '.vim.checkintool.changedfiles'
  let s:cit_buffers.ChangedFiles.fileStatus = {}

  function! s:cit_buffers.ChangedFiles.taggedFileCount() dict
    return len(self.fileStatus) == 0 ? 0 : len(self.fileStatus) - len(filter(copy(self.fileStatus), "v:val == '-'"))
  endfunction

  function! s:cit_buffers.ChangedFiles.persist() dict
    if self.taggedFileCount() == 0
      call delete(self.persist_file)
      return
    endif

    let fileStatusString = 'let self.fileStatus = ' . string(self.fileStatus)
    call writefile([fileStatusString], self.persist_file)
  endfunction

  function! s:cit_buffers.ChangedFiles.load() dict
    if filereadable(self.persist_file)
      let lines = readfile(self.persist_file)
      if !empty(lines)
        execute lines[0]
      endif
    endif
  endfunction

  function! s:cit_buffers.ChangedFiles.removeFileStatus(file) dict
    unlet self.fileStatus[a:file]
  endfunction
endfunction

function! ConstructComments()
  let s:cit_buffers.Comments.persist_file = s:sc_access.getRoot() . '/' . '.vim.checkintool.comments'

  function! s:cit_buffers.Comments.persist() dict
  endfunction

  function! s:cit_buffers.Comments.persist() dict
    if s:cit_buffers.ChangedFiles.taggedFileCount() == 0
      call delete(self.persist_file)
      return
    endif

    call self.goto()
    call writefile(getline(0, "$"), self.persist_file)
  endfunction

  function! s:cit_buffers.Comments.load() dict
    if filereadable(self.persist_file)
      let lines = readfile(self.persist_file)
      if !empty(lines)
        call self.goto()
        call append(0, lines)
        normal Gdd 
      endif
    endif
  endfunction
endfunction

function! CheckInTool()
  augroup checkintool_autogroup 
    autocmd!
    autocmd BufEnter checkintool_* call OnBufEnter() 
    autocmd BufEnter checkintool_ChangedFiles call OnBufEnterChangedFiles()
    autocmd BufLeave checkintool_* call OnBufLeave() 
    autocmd BufLeave checkintool_ChangedFiles call OnBufLeaveChangedFiles()
    autocmd BufLeave checkintool_Comments call OnBufLeaveComments()
    autocmd CursorMoved checkintool_ChangedFiles call OnFilesCursorMoved()
    autocmd CursorMoved checkintool_Comments call OnCommentsCursorMoved()
  aug END

  let s:sc_access = copy(g:bitkeeper_access)
  if !s:sc_access.inRepo()
    echo "The current directory is not in a scm repository"
    echo "Change directory and start again."
    return
  endif

  execute "silent! tabe checkintool_Diffs"
  setf diff
  call SetUpWindow()
  execute "silent! top split checkintool_ChangedFiles"
  call SetUpWindow()
  execute "silent! vertical split checkintool_Comments"
  call SetWindowAsTemp()
  execute "silent! set wrap"
  execute "silent! setlocal spell spellang=en_uk"

  let s:cit_buffers = deepcopy(s:buffers_interface)
  call s:cit_buffers.construct(['Diffs', 'ChangedFiles', 'Comments'])

  call ConstructChangedFiles()
  call s:cit_buffers.ChangedFiles.load()

  call ConstructComments()
  call s:cit_buffers.Comments.load()

  let s:previous_line = -1
  call UpdateChangedFiles()
endfunction

function! CleanUp()
  let s:cit_buffers = {}
endfunction

function! UpdateChangedFiles()
  call s:cit_buffers.ChangedFiles.goto_for_write()
  silent! %delete _
  let current_line = 1
  let fileStatus = {}
  for line in GetChangedFileList()
    let file = Line2File("- " . line)
    let fileStatus[file] = has_key(s:cit_buffers.ChangedFiles.fileStatus, file) ? s:cit_buffers.ChangedFiles.fileStatus[file] : '-'
    let line = fileStatus[file] . ' ' . line
    call setline(current_line, line)
    let current_line += 1
  endfor
  let s:cit_buffers.ChangedFiles.fileStatus = copy(fileStatus)
  call s:cit_buffers.ChangedFiles.finish_write()
  call s:cit_buffers.ChangedFiles.goto()
  try
    call GetFileDiffs(line("."))
  catch /Line2File:null_line/
  endtry
endfunction
  
function! GetChangedFileList()
  call s:cit_buffers.Diffs.goto()
  let changed_files = s:sc_access.getChangedFiles()
  call filter(changed_files, 'v:val !~ ".vim.checkintool"')
  call s:cit_buffers.ChangedFiles.goto()
  return changed_files
endfunction

function! CalculateDiffs(line_number)
  "This should be moved to the access layer
  let file = LineNumber2File(a:line_number)
  if IsNewFile(a:line_number)
    return readfile(s:sc_access.getRoot() . '/' . file)
  elseif HasPendingDelta(a:line_number)
    return s:sc_access.getPendingDeltaComment(file)
  else
    return split(s:sc_access.getDiffs(file), "\n")
  endif
endfunction

function! GetFileDiffs(line_number)
  let lines = CalculateDiffs(a:line_number)
  call s:cit_buffers.Diffs.goto_for_write()
  silent! %delete 
  call setline(1, lines) 
  setf diff
  normal gg
  call s:cit_buffers.Diffs.finish_write()
  call s:cit_buffers.ChangedFiles.goto()
endfunction!

function! CloseCheckinTool()
  try
    call s:cit_buffers.close()
  catch
    echo "ERROR: close"
  endtry
  try
    call CleanUp()
  catch
    echo "ERROR"
  endtry
endfunction

function! OnBufEnter()
  map q <esc>:call CloseCheckinTool()<cr>
  if exists("g:checkintool_use_mapleader")
    map <Leader>cc <esc>:call Commit()<cr>
  else
    map 'cc <esc>:call Commit()<cr>
  endif
endfunction

function! OnBufLeave()
  unmap q
  if exists("g:checkintool_use_mapleader")
    unmap <Leader>cc
  else
    unmap 'cc
  endif
endfunction

function! OnBufLeaveComments()
  call s:cit_buffers.Comments.persist()
endfunction

function! OnBufLeaveChangedFiles()
  call s:cit_buffers.ChangedFiles.persist()
  unmap d
  unmap e
  unmap t
  unmap T
  unmap r
endfunction

function! UpdateComments()
  if s:cit_buffers.ChangedFiles.taggedFileCount() == 0
    call s:cit_buffers.Comments.goto()
    silent! %delete _
    call s:cit_buffers.ChangedFiles.goto()
    call s:cit_buffers.Comments.persist()
  endif
endfunction

function! DispatchChangedFilesAction(func, ...) range
  try
    call call(a:func, [a:firstline, a:lastline] + a:000)
  catch /Line2File:null_line/
    echo "ERROR: No file"
  endtry
endfunction

function! OnBufEnterChangedFiles()
  map d <esc>:call DispatchChangedFilesAction('Discard', line("."))<cr>
  vmap d <esc>:'<,'>call DispatchChangedFilesAction('Discard', -1)<cr>
  map e <esc>:call DispatchChangedFilesAction('Edit', line("."))<cr>
  vmap e <esc>:'<,'>call DispatchChangedFilesAction('Edit', -1)<cr>
  map t <esc>:call DispatchChangedFilesAction('TagFile', line("."), 1)<cr>
  vmap t <esc>:'<,'>call DispatchChangedFilesAction('TagFile', -1, 1)<cr>
  map T <esc>:call DispatchChangedFilesAction('TagFile', line("."), 0)<cr>
  vmap T <esc>:'<,'>call DispatchChangedFilesAction('TagFile', -1, 0)<cr>
  map r <esc>:call UpdateChangedFiles()<cr>
  if has("syntax")
    syntax match SelectedFilesTag  "^+ .*$"
    highlight link SelectedFilesTag Error
  endif
endfunction

function! Redraw()
  execute 'redraw!'
endfunction

function DumpFileStatus()
  echo s:cit_buffers.ChangedFiles.fileStatus
endfunction


function! OnFilesCursorMoved()
  if mode() != 'n'
    return
  endif
  let current_line = line(".")
  if current_line != s:previous_line
    try
      call GetFileDiffs(current_line)
    catch
    endtry
    let s:previous_line = current_line
  endif
endfunction

let s:bug_summaries = {}

function! OnCommentsCursorMoved()
  if exists("g:checkintool_display_td_bug_summary")
    let current_word = expand('<cword>')
    let matches = matchlist(expand('<cword>'), '\(D\|d\)\(\d\{2,\}\)')
    if empty(matches) || len(matches) < 3
      echo ""
      return
    endif
    let bug_id = matches[2]
    if !has_key(s:bug_summaries, bug_id)
      let s:bug_summaries[bug_id] = system("/home/matthewh/work/misc/tools/tdutils/dump-bug-summary.rb " . bug_id)
      call Redraw()
    endif
    echo "Defect " . bug_id . ": " .s:bug_summaries[bug_id]
  endif
endfunction

function! Line2File(line)
  let file = get(split(a:line, " "), 2, "")
  if file == ""
    throw "Line2File:null_line"
  endif
  return file
endfunction

function! LineNumber2File(line_number)
  return Line2File(getline(a:line_number))
endfunction

function! IsNewFile(line_number)
  return get(split(getline(a:line_number), " "), 1, "") =~ '^x'
endfunction

function! HasPendingDelta(line_number)
  return strpart(get(split(getline(a:line_number), " "), 1, ""), 3, 3) =~ 'p'
endfunction

function! DiscardLine(line_number)
  if IsNewFile(a:line_number)
    call delete(s:sc_access.getRoot() . '/' . LineNumber2File(a:line_number))
  else
    call s:sc_access.discard(LineNumber2File(a:line_number))
  endif
  call s:cit_buffers.ChangedFiles.removeFileStatus(LineNumber2File(a:line_number))
endfunction

function! Discard(first_line, last_line, line_number) 
  if exists("g:checkintool_confirm_discards")
    if confirm("Do you really want to discard these changes?", "&y\n&n", 2) == 2
      return
    endif
  endif
  if a:line_number == -1
    call map(range(a:first_line, a:last_line), 'DiscardLine(v:val)')
  else
    call DiscardLine(a:line_number)
  endif
  call UpdateComments()
  call UpdateChangedFiles()
  call Redraw()
endfunction

function! EditFileInLine(file)
  let edit_cmd = exists("g:checkintool_edit_cmd") ? g:checkintool_edit_cmd : ':tabe'
  let cmd = edit_cmd . ' ' . s:sc_access.getRoot() . '/' . a:file
  execute cmd
endfunction

function! Edit(first_line, last_line, line_number)
  if a:line_number == -1
    let lines = map(range(a:first_line, a:last_line), 'LineNumber2File(v:val)')
    call map(lines, 'EditFileInLine(v:val)')
  else
    call EditFileInLine(LineNumber2File(a:line_number))
  endif
endfunction

function! IsTagged(line_number)
  return match(getline(a:line_number), "^+ ") != -1
endfunction

function! TaggedFilesChanged(line_number)
  let name = substitute(LineNumber2File(a:line_number), "\\~", "\\\\~", "g")
  let addedFile = IsTagged(a:line_number)

  call s:cit_buffers.Comments.goto()
  let checkInComment = join(getline(1, '$'), "\n") 

  let filenameAlreadyIncluded = match("\n" . checkInComment, "\n" . name . ":") != -1

  if addedFile && !filenameAlreadyIncluded
    let last = strlen(checkInComment)
    if last > 0 && strpart(checkInComment, last - 2) != "\n\n"
      let matches = matchlist(checkInComment, '\(.*\): \?$')
      let matched_file = len(matches) != 0 ? matches[1] : "" 
      "matched_file should be checked against the changed file list.
      if strpart(checkInComment, last - 1) == "\n" || strlen(matched_file) != 0
        let checkInComment = checkInComment . "\n"
      else
        let checkInComment = checkInComment . "\n\n"
      endif
    endif
    let checkInComment = checkInComment . name . ": "
  elseif filenameAlreadyIncluded && !addedFile
    let pattern = '\(^\|\n\)' . name . ': \n\?'
    let checkInComment = substitute(checkInComment, pattern, "", "")
  endif

  silent! %delete _
  call setline(1, split(checkInComment, "\n")) 

  call s:cit_buffers.ChangedFiles.goto()
endfunction

function! FlipTag(line_number)
  let file = LineNumber2File(a:line_number)
  let s:cit_buffers.ChangedFiles.fileStatus[file] = IsTagged(a:line_number) ? '-' : '+'
  let line = getline(a:line_number)
  return IsTagged(a:line_number) ? substitute(line, "^+", "-", "") : substitute(line, "^-", "+", "")
endfunction

function! TagFileLine(line_number)
  let line = FlipTag(a:line_number)

  call s:cit_buffers.ChangedFiles.start_write()
  call setline(a:line_number, line)
  call TaggedFilesChanged(a:line_number)
  call s:cit_buffers.ChangedFiles.finish_write()
  return IsTagged(a:line_number)
endfunction

function! TagFile(first_line, last_line, line_number, goto_comments)
  let new_tagged_lines = 0
  if a:line_number == -1
    let lines = range(a:first_line, a:last_line)
    call map(lines, 'TagFileLine(v:val)')
    execute 'let new_tagged_lines = ' . join(lines, '+') 
  else
    let new_tagged_lines += TagFileLine(a:line_number)
  endif
  call UpdateComments()
  if new_tagged_lines != 0 && a:goto_comments
    call s:cit_buffers.Comments.goto()
    normal G$
  endif
endfunction

function! Commit()
  if s:cit_buffers.ChangedFiles.taggedFileCount() == 0
    return
  endif

  call s:cit_buffers.ChangedFiles.persist()
  call s:cit_buffers.Comments.persist()

  let taggedFiles = filter(copy(s:cit_buffers.ChangedFiles.fileStatus), "v:val == '+'")
  let taggedFileList = keys(taggedFiles)
  let taggedFullyQualifiedFileList = map(copy(taggedFileList), "s:sc_access.qualifyPath(v:val)")

  if !s:sc_access.checkin(copy(taggedFullyQualifiedFileList), s:cit_buffers.Comments.persist_file)
    call Redraw()
    return
  endif

  call map(taggedFileList, "s:cit_buffers.ChangedFiles.removeFileStatus(v:val)")
  call UpdateComments()
  call UpdateChangedFiles()
  call Redraw()
endfunction
