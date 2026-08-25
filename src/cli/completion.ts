/**
 * `bundo completion <shell>`: static scripts that delegate to the hidden
 * `bundo __complete` endpoint (cobra pattern — task names are dynamic, so
 * generated static lists would always be stale).
 */

import { BundoError, EXIT } from "~/core/errors";

const BASH = `# bundo bash completion — add to ~/.bashrc:
#   eval "$(bundo completion bash)"
_bundo() {
	local IFS=$'\\n'
	local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
	COMPREPLY=($(bundo __complete -- "\${words[@]}" 2>/dev/null | cut -f1))
}
complete -o default -F _bundo bundo
`;

const ZSH = `# bundo zsh completion — add to ~/.zshrc:
#   eval "$(bundo completion zsh)"
_bundo() {
	local -a pairs
	pairs=("\${(@f)$(bundo __complete -- "\${words[@]:1:CURRENT-1}" "\${words[CURRENT]}" 2>/dev/null)}")
	local -a completions
	for pair in "\${pairs[@]}"; do
		completions+=("\${pair/\\t/:}")
	done
	(( \${#completions} )) && _describe 'bundo' completions
}
compdef _bundo bundo
`;

const FISH = `# bundo fish completion — save as ~/.config/fish/completions/bundo.fish:
#   bundo completion fish > ~/.config/fish/completions/bundo.fish
complete -c bundo -f -a "(bundo __complete -- (commandline -opc)[2..] (commandline -ct) 2>/dev/null)"
`;

const POWERSHELL = `# bundo PowerShell completion — add to $PROFILE:
#   bundo completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName bundo -ScriptBlock {
	param($wordToComplete, $commandAst, $cursorPosition)
	$words = $commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() }
	if ($wordToComplete -eq "") { $words = @($words) + @("") }
	bundo __complete -- @($words) 2>$null | ForEach-Object {
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
		throw new BundoError("usage", "Usage: bundo completion <bash|zsh|fish|powershell>");
	}
	const script = SCRIPTS[shell.toLowerCase()];
	if (script === undefined) {
		throw new BundoError("usage", `Unsupported shell "${shell}". Supported: bash, zsh, fish, powershell.`);
	}
	process.stdout.write(script);
	return EXIT.ok;
}
