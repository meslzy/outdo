/**
 * `outdo completion <shell>`: static scripts that delegate to the hidden
 * `outdo __complete` endpoint (cobra pattern — task names are dynamic, so
 * generated static lists would always be stale). Every script also completes
 * `bunx outdo ...`, and calls `bunx outdo` when no global outdo is installed.
 */

import { EXIT, OutdoError } from "~/core/errors";

// `_get_comp_words_by_ref -n :` (bash-completion) keeps `db:reset` one word;
// without bash-completion, COMP_WORDBREAKS splits it and only bare names work.
const BASH = `# outdo bash completion — add to ~/.bashrc:
#   eval "$(outdo completion bash)"
_outdo_complete() {
	local IFS=$'\\n'
	local -a cmd=(outdo)
	command -v outdo >/dev/null 2>&1 || cmd=(bunx outdo)
	COMPREPLY=($("\${cmd[@]}" __complete -- "$@" 2>/dev/null | cut -f1))
}
_outdo_words() {
	if declare -F _get_comp_words_by_ref >/dev/null; then
		_get_comp_words_by_ref -n : cur words cword
	else
		words=("\${COMP_WORDS[@]}")
		cword=$COMP_CWORD
		cur=\${COMP_WORDS[COMP_CWORD]}
	fi
}
_outdo() {
	local cur words cword
	_outdo_words
	_outdo_complete "\${words[@]:1:cword}"
	declare -F __ltrim_colon_completions >/dev/null && __ltrim_colon_completions "$cur"
	return 0
}
# \`bunx outdo ...\` completes like \`outdo ...\`.
_outdo_bunx() {
	local cur words cword
	_outdo_words
	if (( cword > 1 )) && [[ \${words[1]} == outdo || \${words[1]} == @meslzy/outdo ]]; then
		_outdo_complete "\${words[@]:2:cword-1}"
		declare -F __ltrim_colon_completions >/dev/null && __ltrim_colon_completions "$cur"
	fi
	return 0
}
complete -o default -F _outdo outdo
complete -o default -F _outdo_bunx bunx
`;

// Native subscripts (`words[2,CURRENT-1]`), not `${words[@]:1:CURRENT-1}`:
// zsh parses an offset/length that starts with a letter as a history modifier
// (`unrecognized modifier 'C'`). `_describe` splits on `:`, so values escape it.
const ZSH = `# outdo zsh completion — add to ~/.zshrc (after oh-my-zsh / compinit):
#   eval "$(outdo completion zsh)"
_outdo() {
	local -a lines completions cmd
	local line value
	cmd=(outdo)
	(( $+commands[outdo] || $+functions[outdo] )) || cmd=(bunx outdo)
	lines=("\${(@f)$("\${cmd[@]}" __complete -- "\${(@)words[2,CURRENT-1]}" "\${words[CURRENT]}" 2>/dev/null)}")
	for line in "\${lines[@]}"; do
		[[ -z $line ]] && continue
		value=\${line%%$'\\t'*}
		completions+=("\${value//:/\\\\:}:\${line#*$'\\t'}")
	done
	(( \${#completions} )) && _describe -t tasks 'outdo' completions
}
# \`bunx outdo ...\` completes like \`outdo ...\`.
_outdo_bunx() {
	if (( CURRENT > 2 )) && [[ \${words[2]} == (outdo|@meslzy/outdo) ]]; then
		shift words
		(( CURRENT-- ))
		_outdo
	else
		_default
	fi
}
compdef _outdo outdo
compdef _outdo_bunx bunx
`;

const FISH = `# outdo fish completion — save as ~/.config/fish/completions/outdo.fish:
#   outdo completion fish > ~/.config/fish/completions/outdo.fish
function __outdo_complete
	set -l cmd outdo
	command -q outdo; or set cmd bunx outdo
	$cmd __complete -- $argv 2>/dev/null
end
function __outdo_after_bunx
	set -l words (commandline -opc)
	test (count $words) -ge 2; and contains -- $words[2] outdo @meslzy/outdo
end
complete -c outdo -f -a "(__outdo_complete (commandline -opc)[2..] (commandline -ct))"
complete -c bunx -n __outdo_after_bunx -f -a "(__outdo_complete (commandline -opc)[3..] (commandline -ct))"
`;

const POWERSHELL = `# outdo PowerShell completion — add to $PROFILE:
#   outdo completion powershell | Out-String | Invoke-Expression
function global:__OutdoComplete([string[]]$Words, [string]$WordToComplete) {
	# Windows PowerShell drops empty-string args to native commands, so signal
	# "cursor is on a fresh word" with a flag instead of a trailing "".
	$empty = if ($WordToComplete -eq "") { "--empty" } else { $null }
	$lines = if (Get-Command outdo -CommandType Application -ErrorAction SilentlyContinue) {
		outdo __complete $empty -- @($Words) 2>$null
	} else {
		bunx outdo __complete $empty -- @($Words) 2>$null
	}
	$lines | ForEach-Object {
		$parts = $_ -split "\`t", 2
		[System.Management.Automation.CompletionResult]::new($parts[0], $parts[0], 'ParameterValue', $(if ($parts.Length -gt 1 -and $parts[1]) { $parts[1] } else { $parts[0] }))
	}
}
Register-ArgumentCompleter -Native -CommandName outdo -ScriptBlock {
	param($wordToComplete, $commandAst, $cursorPosition)
	$words = $commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() }
	__OutdoComplete $words $wordToComplete
}
# \`bunx outdo ...\` completes like \`outdo ...\`.
Register-ArgumentCompleter -Native -CommandName bunx -ScriptBlock {
	param($wordToComplete, $commandAst, $cursorPosition)
	$elements = $commandAst.CommandElements
	if ($elements.Count -lt 2 -or @('outdo', '@meslzy/outdo') -notcontains $elements[1].ToString()) { return }
	if ($elements.Count -eq 2 -and $wordToComplete -ne "") { return }
	$words = $elements | Select-Object -Skip 2 | ForEach-Object { $_.ToString() }
	__OutdoComplete $words $wordToComplete
}
`;

const SCRIPTS: Record<string, string> = {
	bash: BASH,
	zsh: ZSH,
	fish: FISH,
	powershell: POWERSHELL,
	pwsh: POWERSHELL,
};

export async function completionCommand(shell: string | undefined): Promise<number> {
	if (shell === undefined) {
		throw new OutdoError("usage", "Usage: outdo completion <bash|zsh|fish|powershell>");
	}
	const script = SCRIPTS[shell.toLowerCase()];
	if (script === undefined) {
		throw new OutdoError("usage", `Unsupported shell "${shell}". Supported: bash, zsh, fish, powershell.`);
	}
	process.stdout.write(script);
	return EXIT.ok;
}
