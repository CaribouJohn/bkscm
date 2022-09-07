let g:bitkeeper_access = {}

function! GetRepositoryCount(repoRoot)
  let countfile = tempname()
  let cmd = "cd " . a:repoRoot. "; bk log -hr+ -d:HASHCOUNT: | tail -n 1 > " . countfile . " &"
  call system(cmd)
  let ticks = 0
  let line = ""
  while line == ""
    call Spinner("Counting files", ticks)
    let ticks += 1
    let line = get(readfile(countfile), 0, "")
  endwhile
  let repo_counts = split(line, " ")
  let repo_count = get(repo_counts, 0, 0) + get(repo_counts, 1, 0)
  call delete(countfile)
  return repo_count 
endfunction

function! g:bitkeeper_access.getChangedFiles()
  let repository_count = GetRepositoryCount(self.getRoot()) 
  execute "normal \e\e:"

  let win_width = winwidth(0) - 8
  let increment = repository_count / win_width
  let count_so_far = 0 
  
  let progressfile = tempname()
  let resultsfile = tempname()

  let cmd = "bk -r gfiles -cgxvp -o " . resultsfile . " > " . progressfile . "  && echo done >> ".  progressfile  . " &"
  call system(cmd)
  while 1
    let line = system("tail -n 1 " . progressfile)
    if line == ""
      continue
    endif
    if line =~ "^done"
      break
    endif
    let processed = split(line, " ")[0]
    if processed > count_so_far 
      call ProgressBar(processed * 100 / repository_count, 'Processing files')
      let count_so_far += increment
    endif
  endwhile
  let files = readfile(resultsfile)
  call delete(progressfile)
  call delete(resultsfile)
  return files
endfunction

function! g:bitkeeper_access.getDiffs(file) dict
  if exists("g:checkintool_quick_diffs")
    let tmpfile = tempname()
    let cmd = "bk get -p -r+ " . self.qualifyPath(a:file) . " > " . tmpfile
    call system(cmd)
    let cmd = "diff -up " . tmpfile . " " . self.qualifyPath(a:file)

    let diffs = system(cmd)
    call delete(tmpfile)
    return diffs
  endif
  let cmd = "bk diffs -up " . self.qualifyPath(a:file)
  return system(cmd)
endfunction

function! g:bitkeeper_access.getPendingDeltaComment(file) dict
  let qfile = self.getRoot() . '/' . a:file 
  let cmd = "bk gfiles -pC " . qfile
  let revision = get(split(substitute(system(cmd), "\n$", "", ""), "|"), 1)
  let cmd = "bk log -r" . revision . " -d':COMMENTS:' " . qfile
  return strpart(substitute(system(cmd), "\n$", "", ""), 2)
endfunction

function! g:bitkeeper_access.discard(file) dict
  let cmd = "bk unedit " . self.qualifyPath(a:file) 
  call system(cmd)
endfunction

function! g:bitkeeper_access.getRoot() dict
  return substitute(system("bk root"), "\n$", "", "")
endfunction

function! g:bitkeeper_access.inRepo() dict
  call self.getRoot()
  return v:shell_error == 0
endfunction

function! g:bitkeeper_access.qualifyPath(file) dict
  return self.getRoot() . '/' . a:file
endfunction

function! g:bitkeeper_access.hasRESYNC() dict
  return finddir("RESYNC", self.getRoot()) != ""
endfunction

function! g:bitkeeper_access.checkin(files, comment_file) dict
  if self.hasRESYNC()
    echo "This repository has a RESYNC directory. CheckInTools's BitKeeper back-end doesn't support resolving merge conflicts, nor committing while there are merge conflicts to be resolved. Please use \"bk resolve\" to fix the problem."
    return
  endif

  function! s:CreateDelta(file, comment_file)
    let cmd = 'bk delta -a -Y' . a:comment_file . ' ' . a:file
    echo cmd
    echo system(cmd)
  endfunction

  call map(a:files, 's:CreateDelta(v:val, a:comment_file)')

  let cmd = 'bk commit -Y' . a:comment_file
  if !exists("g:checkintool_bk_pre_commit_check_allow_gui")
    let cmd = 'unset BK_GUI && ' . cmd
  end
  echo cmd
  echo ""
  echo system(cmd)
  let commit_error = v:shell_error
  return !commit_error
endfunction
