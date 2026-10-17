$ErrorActionPreference = "Stop"

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AppDir

node -e "const fs=require('fs'); const env=Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).filter(Boolean).map(l=>{const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1)]})); const key=env.MANUS_API_KEY; if(!key || key==='your_manus_api_key_here') throw new Error('MANUS_API_KEY is not configured in .env'); fetch('https://api.manus.ai/v2/task.create',{method:'POST',headers:{'Content-Type':'application/json','x-manus-api-key':key},body:JSON.stringify({message:{content:'Test my Manus API key. Reply in one short sentence.'},hide_in_task_list:true,title:'My API test'})}).then(async r=>{const text=await r.text(); console.log(text); if(!r.ok) process.exit(1);}).catch(e=>{console.error(e); process.exit(1);})"
