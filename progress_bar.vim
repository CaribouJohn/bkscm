function! ProgressBar(percentage, string)

  let percentage = a:percentage <= 100 ? a:percentage : 100

  let char = "#"
  let barlen = winwidth(0) - strlen(a:string) - 8 

  let chrs = barlen * percentage / 100
  let chrx = barlen  - chrs

  let bar = a:string . "["
  let bar = a:string . "[" . repeat(char, chrs) . repeat(" ", chrx) . "]" 
  if percentage < 10
    let bar = bar . " "
  endif
  let bar = bar . percentage . "%"

  let cmdheight = &cmdheight
  if cmdheight < 2
      let &cmdheight = 2
  endif
  echon "\r" . bar
  let &cmdheight = cmdheight

  if chrs + chrx > barlen
      echo "chrs=" . chrs . ", chrx=" . chrx
  endif

endfunction

let s:spins = ['|', '/', '-', '\'] 

function! Spinner(message, count)
  let place = a:count % 4
  echon "\r" . a:message . " " . s:spins[place] 
  sleep 100m 
endfunction
