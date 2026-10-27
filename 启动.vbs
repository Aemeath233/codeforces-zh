Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
python = root & "\.venv\Scripts\pythonw.exe"
launcher = root & "\launcher.py"
If Not fso.FileExists(python) Then
    MsgBox "Python environment missing. Run uv sync in the project directory.", 16, "CF Mirror"
Else
    shell.Run Chr(34) & python & Chr(34) & " " & Chr(34) & launcher & Chr(34) & " start", 0, False
End If
