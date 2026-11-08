; UE-MCP Studio setup: a wizard over one command, nothing installed beside it.
; It checks for Node.js 20+, offers Node.js LTS through winget, lets the user
; pick a project, then runs `npx ue-mcp install studio <uproject>` and shows
; its output. Built by scripts/build-installer.mjs, which passes the defines.
;
; Unattended: UE-MCP-Studio-Setup.exe /VERYSILENT /PROJECT=<path to .uproject>
; Exit code 0 when Studio was installed, 1 when the command failed.
; /UEMCP=<npm spec> runs another ue-mcp than ue-mcp@latest, e.g. ue-mcp@beta.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0"
#endif

[Setup]
AppId=UE-MCP-Studio-Setup
AppName=UE-MCP Studio
AppVersion={#AppVersion}
AppVerName=UE-MCP Studio
AppPublisher=ue-mcp
AppPublisherURL=https://ue-mcp.com
AppSupportURL=https://github.com/db-lyon/ue-mcp-studio/issues
VersionInfoVersion={#NumericVersion}
VersionInfoDescription=UE-MCP Studio Setup
VersionInfoProductName=UE-MCP Studio
PrivilegesRequired=lowest
; Setup runs the user's own Node.js, which version managers reach through links the user
; made, and it inherits this guard; it installs nothing that needs it.
RedirectionGuard=no
CreateAppDir=no
Uninstallable=no
DisableProgramGroupPage=yes
DisableWelcomePage=no
ShowLanguageDialog=no
WizardStyle=modern dynamic
WizardSizePercent=110
#ifdef IconFile
SetupIconFile={#IconFile}
#endif
#ifdef WizardImages
WizardImageFile={#WizardImages}
WizardSmallImageFile={#WizardSmallImages}
#endif
Compression=lzma2/max
SolidCompression=yes
SetupLogging=yes
OutputBaseFilename=UE-MCP-Studio-Setup
#ifdef Sign
SignTool=studio
SignedUninstaller=no
#endif

[Messages]
SetupAppTitle=UE-MCP Studio Setup
SetupWindowTitle=UE-MCP Studio Setup
WelcomeLabel1=Add UE-MCP Studio to an Unreal project
WelcomeLabel2=Studio is an agent that works inside Unreal Editor. This setup adds it to one of your projects.%n%nClose the project in Unreal before you continue.
ReadyLabel1=Ready to add Studio
ReadyLabel2b=Setup will download Studio and add it to this project:
ButtonInstall=&Install
StatusInstalling=Adding Studio to your project
FinishedHeadingLabel=Studio is installed
ClickFinish=Click Finish to close Setup.

[Code]
const
  NodeMajorMin = 20;
  ProjectsDir = '{localappdata}\UnrealEngine';

var
  NodePage: TWizardPage;
  NodeStatus: TNewStaticText;
  NodeConsent: TNewCheckBox;
  NodeLog: TNewMemo;
  ProjectPage: TWizardPage;
  ProjectList: TNewListBox;
  ProjectPaths: TStringList;
  OutputMemo: TNewMemo;
  OutputLines: TStringList;
  NpxPath: String;
  NodeVersion: String;
  Installed: Boolean;
  Failure: String;

{ ---------------------------------------------------------------- }
{ Output                                                            }
{ ---------------------------------------------------------------- }

{ A CLI line without its colour codes and its leading status glyph. }
function CleanLine(const S: String): String;
var
  I: Integer;
  InEsc: Boolean;
begin
  Result := '';
  InEsc := False;
  for I := 1 to Length(S) do
  begin
    if InEsc then
    begin
      if ((S[I] >= 'A') and (S[I] <= 'Z')) or ((S[I] >= 'a') and (S[I] <= 'z')) then InEsc := False;
    end
    else if S[I] = #27 then
      InEsc := True
    else
      Result := Result + S[I];
  end;
  Result := Trim(Result);
  if (Length(Result) > 2) and (Ord(Result[1]) > 127) and (Pos(' ', Result) <= 4) then
    Result := Trim(Copy(Result, Pos(' ', Result) + 1, MaxInt));
end;

procedure AppendTo(Memo: TNewMemo; const Line: String);
begin
  if Memo <> nil then
  begin
    Memo.Lines.Add(Line);
    Memo.SelStart := Length(Memo.Text);
  end;
end;

procedure OnInstallOutput(const S: String; const Error, FirstLine: Boolean);
var
  Line: String;
begin
  Line := CleanLine(S);
  Log('ue-mcp: ' + S);
  { Diagnostics ue-mcp logs at info level stay in the setup log. }
  if (Line = '') or (Pos('[ue-mcp] info ', Line) = 1) then Exit;
  OutputLines.Add(Line);
  AppendTo(OutputMemo, Line);
  WizardForm.FilenameLabel.Caption := Line;
end;

procedure OnNodeOutput(const S: String; const Error, FirstLine: Boolean);
var
  Line: String;
begin
  Line := CleanLine(S);
  Log('winget: ' + S);
  if Line <> '' then AppendTo(NodeLog, Line);
end;

{ ---------------------------------------------------------------- }
{ Node.js                                                           }
{ ---------------------------------------------------------------- }

{ First stdout line of a command run through cmd.exe, or '' when it fails. }
function FirstLine(const Command: String): String;
var
  Output: TExecOutput;
  Code: Integer;
begin
  Result := '';
  try
    if ExecAndCaptureOutput(ExpandConstant('{cmd}'), '/d /s /c "' + Command + '"', '', SW_HIDE, ewWaitUntilTerminated, Code, Output)
      and (Code = 0) and (GetArrayLength(Output.StdOut) > 0) then
      Result := Trim(Output.StdOut[0]);
  except
    Log(GetExceptionMessage);
  end;
end;

function NodeMajor(const Version: String): Integer;
var
  V: String;
begin
  V := Version;
  if (V <> '') and (V[1] = 'v') then Delete(V, 1, 1);
  if Pos('.', V) > 0 then V := Copy(V, 1, Pos('.', V) - 1);
  Result := StrToIntDef(V, 0);
end;

{ Find node.exe on PATH or where its installer puts it, and the npx.cmd beside it. }
function FindNode: Boolean;
var
  Candidates: TStringList;
  I: Integer;
  Node, Version: String;
begin
  Result := False;
  NpxPath := '';
  NodeVersion := '';
  Candidates := TStringList.Create;
  try
    Node := FirstLine('where node.exe');
    if Node <> '' then Candidates.Add(Node);
    Candidates.Add(ExpandConstant('{commonpf64}\nodejs\node.exe'));
    Candidates.Add(ExpandConstant('{localappdata}\Programs\nodejs\node.exe'));
    for I := 0 to Candidates.Count - 1 do
    begin
      Node := Candidates[I];
      if not FileExists(Node) or not FileExists(ExtractFilePath(Node) + 'npx.cmd') then Continue;
      Version := FirstLine('"' + Node + '" --version');
      Log('Node.js at ' + Node + ': ' + Version);
      if NodeMajor(Version) >= NodeMajorMin then
      begin
        NpxPath := ExtractFilePath(Node) + 'npx.cmd';
        NodeVersion := Version;
        Result := True;
        Exit;
      end;
      if NodeVersion = '' then NodeVersion := Version;
    end;
  finally
    Candidates.Free;
  end;
end;

function HasWinget: Boolean;
begin
  Result := FirstLine('winget --version') <> '';
end;

procedure ShowNodeStatus;
begin
  if NpxPath <> '' then
  begin
    NodeStatus.Caption := 'Node.js ' + NodeVersion + ' is installed.';
    NodeConsent.Visible := False;
  end
  else if HasWinget then
  begin
    if NodeVersion <> '' then
      NodeStatus.Caption := 'Studio needs Node.js ' + IntToStr(NodeMajorMin) + ' or newer, and this computer has ' + NodeVersion + '.'
    else
      NodeStatus.Caption := 'Studio needs Node.js ' + IntToStr(NodeMajorMin) + ' or newer, and it is not installed.';
    NodeStatus.Caption := NodeStatus.Caption + #13#10#13#10 + 'Setup can install the current LTS release with winget, the Windows package manager. Windows may ask for permission.';
    NodeConsent.Visible := True;
  end
  else
  begin
    NodeStatus.Caption := 'Studio needs Node.js ' + IntToStr(NodeMajorMin) + ' or newer. Install the LTS release from https://nodejs.org, then run this setup again.';
    NodeConsent.Visible := False;
  end;
end;

function InstallNode: Boolean;
var
  Code: Integer;
begin
  NodeLog.Visible := True;
  NodeLog.Lines.Clear;
  WizardForm.NextButton.Enabled := False;
  WizardForm.BackButton.Enabled := False;
  try
    ExecAndLogOutput(ExpandConstant('{cmd}'),
      '/d /s /c "winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements"',
      '', SW_HIDE, ewWaitUntilTerminated, Code, @OnNodeOutput);
  except
    AppendTo(NodeLog, GetExceptionMessage);
  end;
  WizardForm.NextButton.Enabled := True;
  WizardForm.BackButton.Enabled := True;
  Result := FindNode;
  ShowNodeStatus;
end;

{ ---------------------------------------------------------------- }
{ Projects                                                          }
{ ---------------------------------------------------------------- }

function Between(const S, Left, Right: String): String;
var
  P: Integer;
begin
  Result := '';
  P := Pos(Left, S);
  if P = 0 then Exit;
  Result := Copy(S, P + Length(Left), MaxInt);
  P := Pos(Right, Result);
  if P > 0 then Result := Copy(Result, 1, P - 1) else Result := '';
end;

{ The engine a .uproject names, else the editor version that last opened it. }
function EngineOf(const Uproject, Fallback: String): String;
var
  Text: AnsiString;
  Assoc: String;
begin
  Result := Fallback;
  if LoadStringFromFile(Uproject, Text) then
  begin
    Assoc := Between(String(Text), '"EngineAssociation"', ',');
    Assoc := Between(Assoc, '"', '"');
    if (Length(Assoc) >= 3) and (Length(Assoc) <= 5) and (Pos('.', Assoc) = 2) then Result := Assoc;
  end;
end;

procedure AddProject(const Path, Engine: String; Top: Boolean);
var
  Item: String;
  I: Integer;
begin
  for I := 0 to ProjectPaths.Count - 1 do
    if CompareText(ProjectPaths[I], Path) = 0 then
    begin
      ProjectList.ItemIndex := I;
      Exit;
    end;
  Item := ChangeFileExt(ExtractFileName(Path), '');
  if Engine <> '' then Item := Item + '    UE ' + Engine;
  Item := Item + '    ' + ExtractFileDir(Path);
  if Top then
  begin
    ProjectPaths.Insert(0, Path);
    ProjectList.Items.Insert(0, Item);
    ProjectList.ItemIndex := 0;
  end
  else
  begin
    ProjectPaths.Add(Path);
    ProjectList.Items.Add(Item);
  end;
end;

{ Every project in the editors' recent lists that still exists, newest first. }
procedure LoadRecentProjects;
var
  Find: TFindRec;
  Root, Line, Path, Stamp: String;
  Lines: TArrayOfString;
  Found: TStringList;
  I: Integer;
begin
  Root := ExpandConstant(ProjectsDir);
  Found := TStringList.Create;
  try
    if FindFirst(Root + '\*', Find) then
    try
      repeat
        if (Find.Attributes and FILE_ATTRIBUTE_DIRECTORY = 0) or (Find.Name = '.') or (Find.Name = '..') then Continue;
        if not LoadStringsFromFile(Root + '\' + Find.Name + '\Saved\Config\WindowsEditor\EditorSettings.ini', Lines) then Continue;
        for I := 0 to GetArrayLength(Lines) - 1 do
        begin
          Line := Trim(Lines[I]);
          if Pos('RecentlyOpenedProjectFiles=', Line) <> 1 then Continue;
          Path := Between(Line, 'ProjectName="', '"');
          StringChangeEx(Path, '/', '\', True);
          Stamp := Between(Line, 'LastOpenTime=', ')');
          if (Path <> '') and FileExists(Path) then
            Found.Add(Stamp + #9 + Find.Name + #9 + Path);
        end;
      until not FindNext(Find);
    finally
      FindClose(Find);
    end;
    Found.Sort;
    for I := Found.Count - 1 downto 0 do
    begin
      Line := Found[I];
      Stamp := Copy(Line, Pos(#9, Line) + 1, MaxInt);
      Path := Copy(Stamp, Pos(#9, Stamp) + 1, MaxInt);
      AddProject(Path, EngineOf(Path, Copy(Stamp, 1, Pos(#9, Stamp) - 1)), False);
    end;
    if ProjectList.Items.Count > 0 then ProjectList.ItemIndex := 0;
  finally
    Found.Free;
  end;
end;

procedure BrowseClick(Sender: TObject);
var
  Path: String;
begin
  Path := '';
  if GetOpenFileName('Choose your Unreal project', Path, ExpandConstant('{userdocs}'), 'Unreal projects (*.uproject)|*.uproject', 'uproject') then
    AddProject(Path, EngineOf(Path, ''), True);
end;

function SelectedProject: String;
begin
  Result := ExpandConstant('{param:PROJECT|}');
  if (Result = '') and (ProjectList <> nil) and (ProjectList.ItemIndex >= 0) then
    Result := ProjectPaths[ProjectList.ItemIndex];
end;

{ ---------------------------------------------------------------- }
{ Install                                                           }
{ ---------------------------------------------------------------- }

function UeMcpSpec: String;
begin
  Result := ExpandConstant('{param:UEMCP|ue-mcp@latest}');
end;

{ --package takes a registry spec or a local tarball alike; ue-mcp is the bin it runs. }
function Npx(const Args: String): String;
begin
  Result := '"' + NpxPath + '" -y --min-release-age=0 --package=' + UeMcpSpec + ' ue-mcp ' + Args;
end;

{ True when the ue-mcp on npm lists the install command; older releases start a server instead. }
function UeMcpCanInstall: Boolean;
var
  Output: TExecOutput;
  Code, I: Integer;
begin
  Result := False;
  try
    if ExecAndCaptureOutput(ExpandConstant('{cmd}'), '/d /s /c "' + Npx('help') + '"', '', SW_HIDE, ewWaitUntilTerminated, Code, Output) then
      for I := 0 to GetArrayLength(Output.StdOut) - 1 do
        if Pos('install ', Trim(Output.StdOut[I]) + ' ') = 1 then Result := True;
  except
    Log(GetExceptionMessage);
  end;
end;

procedure RunInstall;
var
  Project: String;
  Code: Integer;
begin
  Project := SelectedProject;
  Installed := False;
  Failure := '';
  OutputMemo := TNewMemo.Create(WizardForm);
  OutputMemo.Parent := WizardForm.InstallingPage;
  OutputMemo.Left := WizardForm.ProgressGauge.Left;
  OutputMemo.Top := WizardForm.ProgressGauge.Top + WizardForm.ProgressGauge.Height + ScaleY(12);
  OutputMemo.Width := WizardForm.ProgressGauge.Width;
  OutputMemo.Height := WizardForm.InstallingPage.ClientHeight - OutputMemo.Top - ScaleY(4);
  OutputMemo.ReadOnly := True;
  OutputMemo.ScrollBars := ssVertical;
  WizardForm.ProgressGauge.Style := npbstMarquee;

  if NpxPath = '' then
    Failure := 'Node.js ' + IntToStr(NodeMajorMin) + ' or newer was not found.'
  else if (Project = '') or not FileExists(Project) then
    Failure := 'No project was chosen, or it no longer exists: ' + Project
  else
  begin
    WizardForm.StatusLabel.Caption := 'Getting ue-mcp from npm';
    if not UeMcpCanInstall then
      Failure := 'The ue-mcp release on npm cannot install Studio yet. Run this setup again after the next ue-mcp release.'
    else
    begin
      WizardForm.StatusLabel.Caption := 'Adding Studio to ' + ChangeFileExt(ExtractFileName(Project), '');
      try
        ExecAndLogOutput(ExpandConstant('{cmd}'), '/d /s /c "' + Npx('install studio "' + Project + '"') + '"',
          ExtractFileDir(Project), SW_HIDE, ewWaitUntilTerminated, Code, @OnInstallOutput);
        Installed := Code = 0;
        if not Installed then
        begin
          if OutputLines.Count > 0 then Failure := OutputLines[OutputLines.Count - 1]
          else Failure := 'ue-mcp exited with code ' + IntToStr(Code) + '.';
        end;
      except
        Failure := GetExceptionMessage;
      end;
    end;
  end;
  WizardForm.ProgressGauge.Style := npbstNormal;
  WizardForm.ProgressGauge.Position := WizardForm.ProgressGauge.Max;
  if Failure <> '' then Log('Studio was not installed: ' + Failure);
end;

{ ---------------------------------------------------------------- }
{ Wizard                                                            }
{ ---------------------------------------------------------------- }

procedure InitializeWizard;
var
  Browse: TNewButton;
begin
  ProjectPaths := TStringList.Create;
  OutputLines := TStringList.Create;

  NodePage := CreateCustomPage(wpWelcome, 'Node.js', 'Studio runs on Node.js.');
  NodeStatus := TNewStaticText.Create(NodePage);
  NodeStatus.Parent := NodePage.Surface;
  NodeStatus.AutoSize := False;
  NodeStatus.WordWrap := True;
  NodeStatus.Width := NodePage.SurfaceWidth;
  NodeStatus.Height := ScaleY(72);
  NodeConsent := TNewCheckBox.Create(NodePage);
  NodeConsent.Parent := NodePage.Surface;
  NodeConsent.Top := NodeStatus.Top + NodeStatus.Height + ScaleY(8);
  NodeConsent.Width := NodePage.SurfaceWidth;
  NodeConsent.Height := ScaleY(20);
  NodeConsent.Caption := 'Install Node.js LTS with winget';
  NodeConsent.Checked := False;
  NodeLog := TNewMemo.Create(NodePage);
  NodeLog.Parent := NodePage.Surface;
  NodeLog.Top := NodeConsent.Top + NodeConsent.Height + ScaleY(8);
  NodeLog.Width := NodePage.SurfaceWidth;
  NodeLog.Height := NodePage.SurfaceHeight - NodeLog.Top;
  NodeLog.ReadOnly := True;
  NodeLog.ScrollBars := ssVertical;
  NodeLog.Visible := False;

  ProjectPage := CreateCustomPage(NodePage.ID, 'Project', 'Choose the Unreal project to add Studio to.');
  ProjectList := TNewListBox.Create(ProjectPage);
  ProjectList.Parent := ProjectPage.Surface;
  ProjectList.Width := ProjectPage.SurfaceWidth;
  ProjectList.Height := ProjectPage.SurfaceHeight - ScaleY(36);
  Browse := TNewButton.Create(ProjectPage);
  Browse.Parent := ProjectPage.Surface;
  Browse.Caption := '&Browse';
  Browse.Width := ScaleX(90);
  Browse.Height := WizardForm.NextButton.Height;
  Browse.Top := ProjectPage.SurfaceHeight - Browse.Height;
  Browse.Left := ProjectPage.SurfaceWidth - Browse.Width;
  Browse.OnClick := @BrowseClick;

  FindNode;
  ShowNodeStatus;
  LoadRecentProjects;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := ((PageID = NodePage.ID) and (NpxPath <> ''))
    or ((PageID = ProjectPage.ID) and (ExpandConstant('{param:PROJECT|}') <> ''));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = NodePage.ID then
  begin
    { Silent setup never installs Node.js: that needs the consent the box asks for. }
    if (NpxPath <> '') or WizardSilent then Exit;
    if NodeConsent.Visible and NodeConsent.Checked then
    begin
      Result := InstallNode;
      if not Result then
        MsgBox('Node.js was not installed. The winget output is shown on this page.', mbError, MB_OK);
    end
    else
    begin
      Result := FindNode;
      ShowNodeStatus;
      if not Result then
        MsgBox('Studio needs Node.js ' + IntToStr(NodeMajorMin) + ' or newer. Tick the box to install it with winget, or install it yourself and click Next.', mbInformation, MB_OK);
    end;
  end
  else if CurPageID = ProjectPage.ID then
  begin
    Result := SelectedProject <> '';
    if not Result then MsgBox('Choose a project, or click Browse to find its .uproject file.', mbInformation, MB_OK);
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := 'Project:' + NewLine + Space + SelectedProject + NewLine + NewLine
    + 'Setup runs:' + NewLine + Space + 'npx --package=' + UeMcpSpec + ' ue-mcp install studio "' + SelectedProject + '"' + NewLine + NewLine
    + 'This adds the Studio editor plugin to the project, and sets the project up for ue-mcp if it is not yet.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then RunInstall;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Name: String;
begin
  if CurPageID <> wpFinished then Exit;
  Name := ChangeFileExt(ExtractFileName(SelectedProject), '');
  if Installed then
  begin
    WizardForm.FinishedHeadingLabel.Caption := 'Studio is installed';
    WizardForm.FinishedLabel.Caption := 'Open ' + Name + ' in Unreal to finish. Studio opens from the Studio button on the editor toolbar.';
  end
  else
  begin
    WizardForm.FinishedHeadingLabel.Caption := 'Studio was not installed';
    WizardForm.FinishedLabel.Caption := Failure + #13#10#13#10 + 'The full output is in the setup log:' + #13#10 + ExpandConstant('{log}');
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  if Installed then Result := 0 else Result := 1;
end;

procedure DeinitializeSetup;
begin
  ProjectPaths.Free;
  OutputLines.Free;
end;
