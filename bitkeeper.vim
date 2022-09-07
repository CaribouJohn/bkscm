if exists("g:loaded_bitkeeper_vim")
    finish
endif

if v:version < 700
  echoerr "bitkeeper.vim requires vim >= 7."
  finish
endif

let g:loaded_bitkeeper_vim = 1

function! s:ProcessDiff(rawDiff, differences)
  let diffs =  split(a:rawDiff, "\\l")
  let diffType =  substitute(a:rawDiff, '[0-9,]\+', '', 'g')

  "find annotation skip length
  let orig = split(diffs[0], ",")
  if diffType == 'a'
    let annoSkipLength = 0
  else
    if len(orig)  == 1
      let annoSkipLength = 1
    else
      let annoSkipLength = orig[1] - orig[0] + 1
    endif
  endif

  "find change length
  let new = split(diffs[1], ",")
  if diffType == 'd'
    let changeLength = 0
  else
    if len(new) == 1
      let changeLength = 1
    else
      let changeLength = new[1] - new[0] + 1
    endif
  endif

  let a:differences[new[0]] = [diffType, changeLength, annoSkipLength]
endfunction

function! s:GetDiffs(currentFile, differences)
  let fileDiffs = system("bk diffs -hc " . a:currentFile)
  if fileDiffs == ""
    return
  endif
  let fileDiffList = split(fileDiffs, "\n")
  call filter(fileDiffList, 'v:val =~ "^[0-9]"')

  for a_diff in fileDiffList
    call s:ProcessDiff(a_diff, a:differences)
  endfor
endfunction

function! Btkpr_ShowChangeSet(currentLine)
  if a:currentLine =~ '^>'
    return
  endif
  let file_revision = split(a:currentLine)[1]
  let cs_revision = substitute(system("bk r2c -r" . file_revision . " " . w:currentFileRevision['file']), '\n$', '', '')
  call system("bk csettool -f" . w:currentFileRevision['file'] . " -r" . cs_revision . " &")
  redraw!
endfunction

function! Btkpr_GetComment(currentLine)
  if a:currentLine =~'^>'
    return
  endif
  let file_revision = split(a:currentLine)[1]

  let comment = system("bk log -d:COMMENTS: -r" . file_revision . " " . w:currentFileRevision['file'])
  let comment = substitute(comment, '^C ', '', 'g')
  let comment = substitute(comment, '\nC ', '\n', 'g')
  echo comment
endfunction

function! s:WriteAnnotation(annotation, currentLine)
  let trimmed_annotation = substitute(a:annotation, "|.*", "", "g")
  let trimmed_annotation = substitute(trimmed_annotation, " *$", "", "g")
  call setline(a:currentLine, trimmed_annotation)
  return strlen(trimmed_annotation)
endfunction

function! s:RefreshAnnotations(currentFileRevision)

  " Make the annotation modifiable
  setlocal noreadonly
  setlocal modifiable
  " Clear the annotations into blackhole buffer
  silent! %delete _

  let w:currentFileRevision = a:currentFileRevision
  " Get the annotations from bitkeeper
  let [currentFile, revision] = values(w:currentFileRevision)
  let annotations = split(system("bk annotate -Aur -r" . revision . " " . currentFile), "\n")
  let line_number = 1
  let max_annotation_length = 0

  let differences = {}
  " Fill the differences Dictionary
  call s:GetDiffs(currentFile, differences)

  let currentLine = 1
  let currentAnnotation = 0

  while len(differences) || currentAnnotation != len(annotations)

    let difference = get(differences, currentLine, ['n'])

    if difference[0] == 'n' || difference[0] == 'd'

      let line_length =  s:WriteAnnotation(annotations[currentAnnotation], currentLine)
      let max_annotation_length = max([max_annotation_length, line_length])
      let currentAnnotation = currentAnnotation + 1

      if difference[0] == 'd'
        let currentAnnotation = currentAnnotation + difference[2]
        call remove(differences, currentLine)
      endif
      let currentLine = currentLine + 1

    elseif difference[0] == 'a' || difference[0] == 'c'

      let s:count = 0
      let removeThisLine = currentLine
      let label = "> INSERTED"
      if difference[0] == 'c'
        let label = "> CHANGED"
      endif
      while s:count !=  difference[1]
        call setline(currentLine, label)
        let currentLine = currentLine + 1
        let s:count = s:count + 1
      endwhile
      call remove(differences, removeThisLine)
      let currentAnnotation = currentAnnotation + difference[2]

    endif
  endwhile    

  exe 'vert resize ' . (max_annotation_length + 10)

  setlocal nomodifiable
  setlocal readonly

endfunction

function! s:CreateWindow(title, direction)
  let winnum = bufwinnr(a:title)
  if winnum != -1
    " Jump to the existing window
    if winnr() != winnum
      exe winnum . 'wincmd w'
    endif
    return
  endif

  let bufnum = bufnr(a:title)
  if bufnum == -1
    " Create a new buffer
    let wcmd = a:title
  else
    " Edit the existing buffer
    let wcmd = '+buffer' . bufnum
  endif

  " Create the taglist window
  exe 'silent! ' . a:direction . ' split ' . wcmd
  
  setlocal nonumber
  setlocal nomodifiable
  " Mark buffer as scratch
  silent! setlocal buftype=nofile
  silent! setlocal bufhidden=delete
  silent! setlocal noswapfile
  " Due to a bug in Vim 6.0, the winbufnr() function fails for unlisted
  " buffers. So if the taglist buffer is unlisted, multiple taglist
  " windows will be opened. This bug is fixed in Vim 6.1 and above
  if v:version >= 601
    silent! setlocal nobuflisted
  endif

  silent! setlocal number
endfunction

function! s:CreateAnnotationsWindow(title)
  let w:AnnotatedWindow = "active"
  call s:CreateWindow(a:title, 'topleft vertical')
  silent! setlocal scrollbind
endfunction


function! Btkpr_Annotate()
  augroup Btkpr_autogroup 
    autocmd!
    autocmd BufEnter *__Annotations__ call s:EnterBuf()
    autocmd BufLeave *__Annotations__ call s:LeaveBuf()
    autocmd BufUnload *__Annotations__ call s:UnloadBuf()
    autocmd CursorMoved *__Annotations__ call s:OnAnnotationsCursorMoved()
    autocmd BufEnter * call s:GeneralBufEnter()
    autocmd BufLeave * call s:GeneralBufLeave()
  aug END
  
  let g:Annotation_title_suffix = "__Annotations__"

  let currentFile = expand("%:p")
  let bits = split(currentFile, ":")
  let currentFileRevision = {'file' : resolve(bits[0]), 'revision' : get(bits, 1, "+")}

  silent! setlocal scrollbind

  let t:currentCursorPosition = {}
  let t:currentCursorPosition = winsaveview() 
  call s:CreateAnnotationsWindow(currentFileRevision['file'] . g:Annotation_title_suffix)

  call s:RefreshAnnotations(currentFileRevision)
  call winrestview(t:currentCursorPosition) 
  syncbind
endfunction

function! s:DisplayDiffs(currentFileRevision, currentLine)
  let currentFile = a:currentFileRevision['file']
  if a:currentLine =~'^>'
    let diffs = "" 
  else
    let file_revision = split(a:currentLine)[1]

    let previous = system("bk prs -h -r" . file_revision . " -d:PARENT: " . currentFile)
    let diffs = split(system("bk diffs -up -r" .  previous  . " -r" . file_revision . " " . currentFile) , "\n")
  endif

  setlocal modifiable
  silent! %delete 
  call setline(1, diffs) 
  setf diff
  normal gg
  setlocal nomodifiable
  let annotationsWinnr = bufwinnr(g:Annotation_title_suffix . currentFile)
  exe annotationsWinnr . "wincmd W"
endfunction

function! s:RefreshDiffs(currentFileRevision, currentLine)
  if exists("g:Diffs_title_suffix") == 0
    return
  endif
  let winnum = bufwinnr(a:currentFileRevision['file'] . g:Diffs_title_suffix)
  if winnum == -1
    return
  endif
  " Jump to the existing window
  if winnr() != winnum
    exe winnum . 'wincmd w'
  endif

  call s:DisplayDiffs(a:currentFileRevision, a:currentLine)

endfunction


function! s:CreateDiffsWindow(title)
  call s:CreateWindow(a:title, 'bo')
endfunction

function! Btkpr_ToggleDiffs(currentFileRevision, line)
  let g:Diffs_title_suffix = "__DIFFS__"

  silent! setlocal scrollbind

  let t:currentCursorPosition = {}
  let t:currentCursorPosition = winsaveview() 
  let bufnum = bufnr(a:currentFileRevision['file'] . g:Diffs_title_suffix)
  if bufnum != -1 && bufloaded(bufnum)
    exe ":bd" . bufnum 
    return
  endif
  call s:CreateDiffsWindow(a:currentFileRevision['file'] . g:Diffs_title_suffix)
  call s:DisplayDiffs(a:currentFileRevision, a:line)
  call winrestview(t:currentCursorPosition) 
  syncbind
endfunction

function! Btkpr_ViewRevision(currentFileRevision, line)
  if a:line =~'^>'
    return
  endif
  let file_revision = split(a:line)[1]
  exe ":tabe " . a:currentFileRevision . ":" . file_revision
endfunction

function! s:EnterBuf()
  map <silent> <cr> <esc>:call Btkpr_ShowChangeSet(getline(line(".")))<cr>
  map <silent> c <esc>:call Btkpr_GetComment(getline(line(".")))<cr>
  map <silent> d <esc>:call Btkpr_ToggleDiffs(w:currentFileRevision, getline(line(".")))<cr>
  map <silent> v <esc>:call Btkpr_ViewRevision(w:currentFileRevision['file'], getline(line(".")))<cr>
  call s:RefreshAnnotations(w:currentFileRevision)
  call winrestview(t:currentCursorPosition) 
endfunction

function! s:LeaveBuf()
  unmap <cr>
  unmap c
  unmap d
  unmap v
  let t:currentCursorPosition = winsaveview() 
endfunction

function! s:GeneralBufEnter()
  if exists("w:AnnotatedWindow") && w:AnnotatedWindow == "active"
    call winrestview(t:currentCursorPosition) 
  endif
endfunction

function! s:GeneralBufLeave()
  if exists("w:AnnotatedWindow") && w:AnnotatedWindow == "active"
    let t:currentCursorPosition = winsaveview() 
  endif
endfunction

function! s:UnloadBuf()
  let i = 1
  let bnum = winbufnr(i)
  while bnum != -1
    if getwinvar(i, 'AnnotatedWindow') == "active"
      call setwinvar(i, "AnnotatedWindow", "inactive")
      break
    endif
    let i = i + 1
    let bnum = winbufnr(i)
  endwhile
  autocmd! Btkpr_autogroup
endfunction

function! s:OnAnnotationsCursorMoved()
  call s:RefreshDiffs(w:currentFileRevision, getline(line(".")))
endfunction

function! BKanon_newfileaction()
  let currentFile = expand("%:p")
  let [file, revision] = split(currentFile, ":") 
  let contents = system("bk get -p -r".revision." ".resolve(file))
  if v:shell_error == 0
    call append(0, split(contents, "\n"))
    exec ":doauto BufNewFile ".file
    normal gg
    setlocal nomodifiable
  else
    call confirm("Can't find revision: " . revision . " of file: " . file, "enter")
    exec (winnr("$") == 1) ? "q!" : ":clo!"
  endif
endfunction

augroup bkanon
  autocmd BufNewFile *:* call BKanon_newfileaction()
augroup END
