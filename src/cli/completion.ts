/**
 * `outdo completion <shell>`: static scripts that delegate to the hidden
 * `outdo __complete` endpoint (cobra pattern — task names are dynamic, so
 * generated static lists would always be stale).
 */

import { EXIT, OutdoError } from "~/core/errors";

const BASH = `# outdo bash completion — add to ~/.bashrc:
#   eval "$(outdo completion bash)"
_outdo() {
	local IFS=$'\\n'
	local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
	COMPREPLY=($(outdo __complete -- "\${words[@]}" 2>/dev/null | cut -f1))
}
complete -o default -F _outdo outdo
`;

// Native subscripts (`words[2,CURRENT-1]`), not `${words[@]:1:CURRENT-1}`:
// zsh parses an offset/length that starts with a letter as a history modifier
// (`unrecognized modifier 'C'`). `_describe` splits on `:`, so values escape it.
const ZSH = `# outdo zsh completion — add to ~/.zshrc (after oh-my-zsh / compinit):
#   eval "$(outdo completion zsh)"
_outdo() {
	local -a lines completions
	local line value
	lines=("\${(@f)$(outdo __complete -- "\${(@)words[2,CURRENT-1]}" "\${words[CURRENT]}" 2>/dev/null)}")
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
complete -c outdo -f -a "(outdo __complete -- (commandline -opc)[2..] (commandline -ct) 2>/dev/null)"
`;

const POWERSHELL = `# outdo PowerShell completion — add to $PROFILE:
#   outdo completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName outdo -ScriptBlock {
	param($wordToComplete, $commandAst, $cursorPosition)
	$words = $commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() }
	# Windows PowerShell drops empty-string args to native commands, so signal
	# "cursor is on a fresh word" with a flag instead of a trailing "".
	$empty = if ($wordToComplete -eq "") { "--empty" } else { $null }
	outdo __complete $empty -- @($words) 2>$null | ForEach-Object {
		$parts = $_ -split "\`t", 2
		[System.Management.Automation.CompletionResult]::new($parts[0], $parts[0], 'ParameterValue', $(if ($parts.Length -gt 1 -and $parts[1]) { $parts[1] } else { $parts[0] }))
	}
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
