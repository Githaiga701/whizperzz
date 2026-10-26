# One-off cleanup for the Whizperz repo. Run from the Whizperz folder:  powershell -ExecutionPolicy Bypass -File .\tidy-up.ps1
# Removes the old static HTML site (replaced by the Astro site in site/) and leftover build/test output.
# It does NOT touch site\data (your saved journeys, quotes and users). Nothing is committed; review with "git status".
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$oldSite = @('index.html','about.html','contact.html','destinations.html','faq.html','gallery.html',
             'packages.html','payments.html','privacy.html','script.js','styles.css','site-config.js',
             '.env.example','PAYMENTS_SETUP.md')
foreach ($f in $oldSite) {
  if (Test-Path $f) {
    git rm -q --ignore-unmatch -- $f
    if (Test-Path $f) { Remove-Item -Force $f }
    Write-Host "  removed $f"
  }
}

# Generated folders: rebuilt by the next build or test run, never committed.
foreach ($d in @('site\dist','site\.astro','site\.vercel','site\test-results','site\playwright-report','site\.e2e-data')) {
  if (Test-Path $d) { Remove-Item -Recurse -Force $d; Write-Host "  cleared $d" }
}

# Take out anything Git was tracking that the .gitignore files now exclude (files stay on disk).
git rm -r -q --cached --ignore-unmatch site/dist site/.astro site/test-results site/playwright-report site/.e2e-data | Out-Null

git add -A
Write-Host ""
Write-Host "  Done. Changes are staged, not committed:"
git status --short
Remove-Item -Force $PSCommandPath
