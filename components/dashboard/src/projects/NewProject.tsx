/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { useContext, useEffect, useState } from "react";
import { getGitpodService, gitpodHostUrl } from "../service/service";
import { iconForAuthProvider, openAuthorizeWindow, simplifyProviderName } from "../provider-utils";
import { AuthProviderInfo, Project, ProviderRepository, Team, TeamMemberInfo, User } from "@gitpod/gitpod-protocol";
import { TeamsContext } from "../teams/teams-context";
import { useLocation } from "react-router";
import ContextMenu, { ContextMenuEntry } from "../components/ContextMenu";
import CaretDown from "../icons/CaretDown.svg";
import Plus from "../icons/Plus.svg";
import Switch from "../icons/Switch.svg";
import NoAccess from "../icons/NoAccess.svg";
import search from "../icons/search.svg";
import moment from "moment";
import { UserContext } from "../user-context";
import { trackEvent } from "../Analytics";
import exclamation from "../images/exclamation.svg";

export default function NewProject() {
    const location = useLocation();
    const { teams } = useContext(TeamsContext);
    const { user, setUser } = useContext(UserContext);

    const [selectedProviderHost, setSelectedProviderHost] = useState<string | undefined>();
    const [reposInAccounts, setReposInAccounts] = useState<ProviderRepository[]>([]);
    const [repoSearchFilter, setRepoSearchFilter] = useState<string>("");
    const [selectedAccount, setSelectedAccount] = useState<string | undefined>(undefined);
    const [noOrgs, setNoOrgs] = useState<boolean>(false);
    const [showGitProviders, setShowGitProviders] = useState<boolean>(false);
    const [selectedRepo, setSelectedRepo] = useState<ProviderRepository | undefined>(undefined);
    const [selectedTeamOrUser, setSelectedTeamOrUser] = useState<Team | User | undefined>(undefined);

    const [showNewTeam, setShowNewTeam] = useState<boolean>(false);
    const [loaded, setLoaded] = useState<boolean>(false);

    const [project, setProject] = useState<Project | undefined>();
    const [guessedConfigString, setGuessedConfigString] = useState<string | undefined>();
    const [sourceOfConfig, setSourceOfConfig] = useState<"repo" | "db" | undefined>();

    const [authProviders, setAuthProviders] = useState<AuthProviderInfo[]>([]);

    useEffect(() => {
        if (user && selectedProviderHost === undefined) {
            if (user.identities.find(i => i.authProviderId === "Public-GitLab")) {
                setSelectedProviderHost("gitlab.com");
            } else if (user.identities.find(i => i.authProviderId === "Public-GitHub")) {
                setSelectedProviderHost("github.com");
            } else if (user.identities.find(i => i.authProviderId === "Public-Bitbucket")) {
                setSelectedProviderHost("bitbucket.org");
            }
            (async () => {
                setAuthProviders(await getGitpodService().server.getAuthProviders());
            })();
        }
    }, [user]);

    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const teamParam = params.get("team");
        if (teamParam) {
            window.history.replaceState({}, '', window.location.pathname);
            const team = teams?.find(t => t.slug === teamParam);
            setSelectedTeamOrUser(team);
        }
        if (params.get("user")) {
            window.history.replaceState({}, '', window.location.pathname);
            setSelectedTeamOrUser(user);
        }
    }, []);

    const [ teamMembers, setTeamMembers ] = useState<Record<string, TeamMemberInfo[]>>({});
    useEffect(() => {
        if (!teams) {
            return;
        }
        (async () => {
            const members: Record<string, TeamMemberInfo[]> = {};
            await Promise.all(teams.map(async (team) => {
                try {
                    members[team.id] = await getGitpodService().server.getTeamMembers(team.id);
                } catch (error) {
                    console.error('Could not get members of team', team, error);
                }
            }));
            setTeamMembers(members);
        })();
    }, [teams]);

    useEffect(() => {
        if (selectedRepo) {
            (async () => {

                try {
                    const guessedConfigStringPromise = getGitpodService().server.guessRepositoryConfiguration(selectedRepo.cloneUrl);
                    const repoConfigString = await getGitpodService().server.fetchRepositoryConfiguration(selectedRepo.cloneUrl);
                    if (repoConfigString) {
                        setSourceOfConfig("repo");
                    } else {
                        setGuessedConfigString(await guessedConfigStringPromise || `tasks:
  - init: |
      echo 'TODO: build project'
    command: |
      echo 'TODO: start app'`);
                        setSourceOfConfig("db");
                    }
                } catch (error) {
                    console.error('Getting project configuration failed', error);
                    setSourceOfConfig(undefined);
                }

            })();
        }
    }, [selectedRepo]);

    useEffect(() => {
        if (selectedTeamOrUser && selectedRepo) {
            createProject(selectedTeamOrUser, selectedRepo);
        }
    }, [selectedTeamOrUser, selectedRepo]);

    useEffect(() => {
        if (reposInAccounts.length === 0) {
            setSelectedAccount(undefined);
        } else {
            const first = reposInAccounts[0];
            if (!!first.installationUpdatedAt) {
                const mostRecent = reposInAccounts.reduce((prev, current) => (prev.installationUpdatedAt || 0) > (current.installationUpdatedAt || 0) ? prev : current);
                setSelectedAccount(mostRecent.account);
            } else {
                setSelectedAccount(first.account);
            }
        }

    }, [reposInAccounts]);

    useEffect(() => {
        setRepoSearchFilter("");
    }, [selectedAccount]);

    useEffect(() => {
        if (!selectedProviderHost || isBitbucket()) {
            return;
        }
        (async () => {
            updateOrgsState();
            await updateReposInAccounts();
        })();
    }, [selectedProviderHost]);

    useEffect(() => {
        if (project && sourceOfConfig) {
            (async () => {
                if (guessedConfigString && sourceOfConfig === "db") {
                    await getGitpodService().server.setProjectConfiguration(project.id, guessedConfigString);
                }
                await getGitpodService().server.triggerPrebuild(project.id, null);
            })();
        }
    }, [project, sourceOfConfig]);

    const isGitHub = () => selectedProviderHost === "github.com";
    const isBitbucket = () => selectedProviderHost === "bitbucket.org";

    const updateReposInAccounts = async (installationId?: string) => {
        setLoaded(false);
        setReposInAccounts([]);
        if (!selectedProviderHost || isBitbucket()) {
            return [];
        }
        try {
            const repos = await getGitpodService().server.getProviderRepositoriesForUser({ provider: selectedProviderHost, hints: { installationId } });
            setReposInAccounts(repos);
            setLoaded(true);
            return repos;
        } catch (error) {
            console.log(error);
        }
        return [];
    }

    const getToken = async (host: string) => {
        return getGitpodService().server.getToken({ host });
    }

    const updateOrgsState = async () => {
        if (selectedProviderHost && isGitHub()) {
            try {
                const ghToken = await getToken(selectedProviderHost);
                setNoOrgs(ghToken?.scopes.includes("read:org") !== true);
            } catch {
            }
        }
    }

    const reconfigure = () => {
        openReconfigureWindow({
            account: selectedAccount,
            onSuccess: (p: { installationId: string, setupAction?: string }) => {
                updateReposInAccounts(p.installationId);
                trackEvent("organisation_authorised", {
                    installation_id: p.installationId,
                    setup_action: p.setupAction
                });
            }
        });
    }

    const grantReadOrgPermissions = async () => {
        try {
            await openAuthorizeWindow({
                host: "github.com",
                scopes: ["read:org"],
                onSuccess: () => {
                    updateReposInAccounts();
                    updateOrgsState();
                }
            })
        } catch (error) {
            console.log(error);
        }
    }

    const createProject = async (teamOrUser: Team | User, repo: ProviderRepository) => {
        if (!selectedProviderHost || isBitbucket()) {
            return;
        }
        const repoSlug = repo.path || repo.name;

        try {
            const project = await getGitpodService().server.createProject({
                name: repo.name,
                slug: repoSlug,
                cloneUrl: repo.cloneUrl,
                account: repo.account,
                provider: selectedProviderHost,
                ...(User.is(teamOrUser) ? { userId: teamOrUser.id } : { teamId: teamOrUser.id }),
                appInstallationId: String(repo.installationId),
            });

            setProject(project);
        } catch (error) {
            const message = (error && error?.message) || "Failed to create new project."
            window.alert(message);
        }
    }

    const toSimpleName = (fullName: string) => {
        const splitted = fullName.split("/");
        if (splitted.length < 2) {
            return fullName;
        }
        return splitted.shift() && splitted.join("/");
    }

    const accounts = new Map<string, { avatarUrl: string }>();
    reposInAccounts.forEach(r => { if (!accounts.has(r.account)) accounts.set(r.account, { avatarUrl: r.accountAvatarUrl }) });

    const getDropDownEntries = (accounts: Map<string, { avatarUrl: string }>) => {
        const renderItemContent = (label: string, icon: string, addClasses?: string) => (<div className="w-full flex">
            <img src={icon} className="rounded-full w-6 h-6 my-auto" />
            <span className={"pl-2 text-gray-600 dark:text-gray-100 text-base " + (addClasses || "")}>{label}</span>
        </div>)
        const result: ContextMenuEntry[] = [];
        for (const [ account, props ] of accounts.entries()) {
            result.push({
                title: account,
                customContent: renderItemContent(account, props.avatarUrl, "font-semibold"),
                separator: true,
                onClick: () => setSelectedAccount(account),
            })
        }
        if (isGitHub()) {
            result.push({
                title: "Add another GitHub account",
                customContent: renderItemContent("Add GitHub Orgs or Account", Plus),
                separator: true,
                onClick: () => reconfigure(),
            })
        }
        result.push({
            title: "Select another Git Provider to continue with",
            customContent: renderItemContent("Select Git Provider", Switch),
            onClick: () => setShowGitProviders(true),
        })

        return result;
    }

    const renderSelectRepository = () => {

        const noReposAvailable = reposInAccounts.length === 0;
        const filteredRepos = Array.from(reposInAccounts).filter(r => r.account === selectedAccount && `${r.name}`.toLowerCase().includes(repoSearchFilter.toLowerCase()));
        const icon = selectedAccount && accounts.get(selectedAccount)?.avatarUrl;

        const showSearchInput = !!repoSearchFilter || filteredRepos.length > 0;

        const renderRepos = () => (<>
            {!isBitbucket() && <p className="text-gray-500 text-center text-base">Select a Git repository on <strong>{selectedProviderHost}</strong>. (<a className="gp-link cursor-pointer" onClick={() => setShowGitProviders(true)}>change</a>)</p>}
            <div className={`mt-10 border rounded-xl border-gray-100 dark:border-gray-800 flex-col`}>
                <div className="px-8 pt-8 flex flex-col space-y-2" data-analytics='{"label":"Identity"}'>
                    <ContextMenu classes="w-full left-0 cursor-pointer" menuEntries={getDropDownEntries(accounts)}>
                        <div className="w-full">
                            {icon && (
                                <img src={icon} className="rounded-full w-6 h-6 absolute top-1/4 left-4" />
                            )}
                            <input className="w-full px-12 cursor-pointer font-semibold" readOnly type="text" value={selectedAccount || ""}></input>
                            <img src={CaretDown} title="Select Account" className="filter-grayscale absolute top-1/2 right-3" />
                        </div>
                    </ContextMenu>
                    {showSearchInput && (
                        <div className="w-full relative ">
                            <img src={search} title="Search" className="filter-grayscale absolute top-1/3 left-3" />
                            <input className="w-96 pl-10 border-0" type="text" placeholder="Search Repositories" value={repoSearchFilter}
                                onChange={(e) => setRepoSearchFilter(e.target.value)}></input>
                        </div>
                    )}
                </div>
                <div className="p-6 flex-col">
                    {filteredRepos.length > 0 && (
                        <div className="overscroll-contain max-h-80 overflow-y-auto pr-2">
                            {filteredRepos.map((r, index) => (
                                <div key={`repo-${index}-${r.account}-${r.name}`} className="flex p-3 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 focus:bg-gitpod-kumquat-light transition ease-in-out group" >

                                    <div className="flex-grow">
                                        <div className="text-base text-gray-900 dark:text-gray-50 font-medium rounded-xl whitespace-nowrap">{toSimpleName(r.name)}</div>
                                        <p>Updated {moment(r.updatedAt).fromNow()}</p>
                                    </div>
                                    <div className="flex justify-end">
                                        <div className="h-full my-auto flex self-center opacity-0 group-hover:opacity-100">
                                            {!r.inUse ? (
                                                <button className="primary" onClick={() => setSelectedRepo(r)}>Select</button>
                                            ) : (
                                                <p className="my-auto">already taken</p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    {!noReposAvailable && filteredRepos.length === 0 && (
                        <p className="text-center">No Results</p>
                    )}
                    {loaded && noReposAvailable && isGitHub() && (<div>
                        <div className="px-12 py-20 text-center text-gray-500 bg-gray-50 dark:bg-gray-800 rounded-xl">
                            <img src={NoAccess} title="No Access" className="m-auto mb-4" />
                            <h3 className="text-center text-gray-600 dark:text-gray-50 pb-3 font-bold">
                                No Access
                            </h3>
                            <span className="dark:text-gray-400">
                                Authorize GitHub (github.com) or select a different account.
                            </span>
                            <br />
                            <button className="mt-6" onClick={() => reconfigure()}>Authorize</button>
                        </div>
                    </div>)}
                </div>

            </div>
            {isGitHub() && (
                    <div className="pt-3">
                        <div className="text-gray-500 text-center w-96 mx-8">
                            Repository not found? <a href="javascript:void(0)" onClick={e => reconfigure()} className="text-gray-400 underline underline-thickness-thin underline-offset-small hover:text-gray-600">Reconfigure</a>
                        </div>
                        {isGitHub() && noOrgs && (
                            <div className="text-gray-500 mx-auto text-center">
                                Missing organizations? <a href="javascript:void(0)" onClick={e => grantReadOrgPermissions()} className="text-gray-400 underline underline-thickness-thin underline-offset-small hover:text-gray-600">Grant permissions</a>
                            </div>
                        )}
                    </div>
            )}
            <p className="text-left w-full mt-12 text-gray-500">
                <strong>Teams &amp; Projects</strong> are currently in Beta. <a href="https://github.com/gitpod-io/gitpod/issues/5095" target="gitpod-feedback-issue" rel="noopener" className="gp-link">Send feedback</a> or open a <a href="/workspaces" className="gp-link">New Workspace</a> with an example repository.
            </p>
        </>
        );

        const renderLoadingState = () => (<div>
            <div className="mt-8 border rounded-xl border-gray-100 dark:border-gray-700 flex-col">
                <div>
                    <div className="px-12 py-16 text-center text-gray-500 bg-gray-50 dark:bg-gray-800 rounded-xl w-96 h-h96 flex items-center justify-center">
                        <h3 className="mb-2 text-gray-400 dark:text-gray-600 animate-pulse">
                            Loading ...
                        </h3>
                    </div>
                </div>
            </div>
        </div>)

        const onGitProviderSeleted = async (host: string, updateUser?: boolean) => {
            if (updateUser) {
                setUser(await getGitpodService().server.getLoggedInUser());
            }
            setShowGitProviders(false);
            setSelectedProviderHost(host);
        }

        if (!loaded && !isBitbucket()) {
            return renderLoadingState();
        }

        if (showGitProviders || isBitbucket()) {
            return (<GitProviders onHostSelected={onGitProviderSeleted} authProviders={authProviders} />);
        }

        return renderRepos();
    };

    const renderSelectTeam = () => {
        const userFullName = user?.fullName || user?.name || '...';
        const teamsToRender = teams || [];
        return (<>
            <p className="mt-2 text-gray-500 text-center text-base">Select team or personal account</p>
            <div className="mt-14 flex flex-col space-y-2">
                <label key={`user-${userFullName}`} className={`w-80 px-4 py-3 flex space-x-3 items-center cursor-pointer rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800`} onClick={() => setSelectedTeamOrUser(user)}>
                    <input type="radio" />
                    <div className="flex-grow overflow-ellipsis truncate flex flex-col">
                        <span className="font-semibold">{userFullName}</span>
                        <span className="text-sm text-gray-400">Personal account</span>
                    </div>
                </label>
                {teamsToRender.map((t) => (
                    <label key={`team-${t.name}`} className={`w-80 px-4 py-3 flex space-x-3 items-center cursor-pointer rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800`} onClick={() => setSelectedTeamOrUser(t)}>
                        <input type="radio" />
                        <div className="flex-grow overflow-ellipsis truncate flex flex-col">
                            <span className="font-semibold">{t.name}</span>
                            <span className="text-sm text-gray-400">{!!teamMembers[t.id]
                                ? `${teamMembers[t.id].length} member${teamMembers[t.id].length === 1 ? '' : 's'}`
                                : 'Team'
                            }</span>
                        </div>
                    </label>
                ))}
                <label className="w-80 px-4 py-3 flex flex-col cursor-pointer rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800">
                    <div className="flex space-x-3 items-center relative">
                        <input type="radio" onChange={() => setShowNewTeam(!showNewTeam)} />
                        <div className="flex-grow overflow-ellipsis truncate flex flex-col">
                            <span className="font-semibold">Create new team</span>
                            <span className="text-sm text-gray-400">Collaborate with others</span>
                        </div>
                        {teamsToRender.length > 0 && (
                            <img alt="" src={CaretDown} title="Select Account" className={`${showNewTeam ? "transform rotate-180" : ""} filter-grayscale absolute top-1/2 right-3 cursor-pointer`} />
                        )}
                    </div>
                    {(showNewTeam || teamsToRender.length === 0) && (
                        <NewTeam onSuccess={(t) => setSelectedTeamOrUser(t)} />
                    )}
                </label>
            </div>
        </>)
    };

    const renderBitbucketWarning = () => {
        return (
            <div className="mt-16 flex space-x-2 py-6 px-6 w-96 justify-betweeen bg-gitpod-kumquat-light rounded-xl">
            <div className="pr-3 self-center w-6">
                <img src={exclamation} />
            </div>
            <div className="flex-1 flex flex-col">
                <p className="text-gitpod-red text-sm">Bitbucket support for projects is not available yet. Follow <a className="gp-link" href="https://github.com/gitpod-io/gitpod/issues/5980">#5980</a> for updates.</p>
            </div>
        </div>);
    }

    const onNewWorkspace = async () => {
        const redirectToNewWorkspace = () => {
            // instead of `history.push` we want forcibly to redirect here in order to avoid a following redirect from `/` -> `/projects` (cf. App.tsx)
            const url = new URL(window.location.toString());
            url.pathname = "/";
            url.hash = project?.cloneUrl!;
            window.location.href = url.toString();
        }
        redirectToNewWorkspace();
    }

    if (!project) {
        return (<div className="flex flex-col w-96 mt-24 mx-auto items-center">

            <>
                <h1>New Project</h1>

                {!selectedRepo && renderSelectRepository()}

                {selectedRepo && !selectedTeamOrUser && renderSelectTeam()}

                {selectedRepo && selectedTeamOrUser && (<div></div>)}
            </>

            {isBitbucket() && renderBitbucketWarning()}

        </div>);
    } else {
        const projectLink = User.is(selectedTeamOrUser) ? `/projects/${project.slug}` : `/t/${selectedTeamOrUser?.slug}/${project.slug}`;
        const location = User.is(selectedTeamOrUser) ? "" : (<> in team <a className="gp-link" href={`/t/${selectedTeamOrUser?.slug}/projects`}>{selectedTeamOrUser?.name}</a></>);

        return (<div className="flex flex-col w-96 mt-24 mx-auto items-center">

            <>
                <h1>Project Created</h1>

                <p className="mt-2 text-gray-500 text-center text-base">Created <a className="gp-link" href={projectLink}>{project.name}</a> {location}
                </p>

                <div className="mt-12">
                    <button onClick={onNewWorkspace}>New Workspace</button>
                </div>

            </>

        </div>);
    }

}

function GitProviders(props: {
    authProviders: AuthProviderInfo[],
    onHostSelected: (host: string, updateUser?: boolean) => void
}) {
    const [ errorMessage, setErrorMessage ] = useState<string | undefined>(undefined);

    const selectProvider = async (ap: AuthProviderInfo) => {
        setErrorMessage(undefined);

        const token = await getGitpodService().server.getToken({ host: ap.host });
        if (token) {
            props.onHostSelected(ap.host);
            return;
        }
        await openAuthorizeWindow({
            host: ap.host,
            scopes: ap.requirements?.default,
            onSuccess: async () => {
                props.onHostSelected(ap.host, true);
            },
            onError: (payload) => {
                let errorMessage: string;
                if (typeof payload === "string") {
                    errorMessage = payload;
                } else {
                    errorMessage = payload.description ? payload.description : `Error: ${payload.error}`;
                    if (payload.error === "email_taken") {
                        errorMessage = `Email address already used in another account. Please log in with ${(payload as any).host}.`;
                    }
                }
                setErrorMessage(errorMessage);
            }
        });
    }

    // for now we exclude bitbucket.org and GitHub Enterprise
    const filteredProviders = () => props.authProviders.filter(p => p.host === "github.com" || p.authProviderType === "GitLab");

    return (
        <div className="mt-8 border rounded-t-xl border-gray-100 dark:border-gray-800 flex-col">
            <div className="p-6 p-b-0">
                <div className="text-center text-gray-500">
                    Select a Git provider first and continue with your repositories.
                </div>
                <div className="mt-6 flex flex-col space-y-3 items-center pb-8">
                    {filteredProviders().map(ap => {
                        return (
                            <button key={"button" + ap.host} className="btn-login flex-none w-56 h-10 p-0 inline-flex" onClick={() => selectProvider(ap)}>
                                {iconForAuthProvider(ap.authProviderType)}
                                <span className="pt-2 pb-2 mr-3 text-sm my-auto font-medium truncate overflow-ellipsis">Continue with {simplifyProviderName(ap.host)}</span>
                            </button>
                        );
                    })}
                </div>

                {errorMessage && (
                    <div className="mt-16 flex space-x-2 py-6 px-6 w-96 justify-between bg-gitpod-kumquat-light rounded-xl">
                        <div className="pr-3 self-center w-6">
                            <img src={exclamation} />
                        </div>
                        <div className="flex-1 flex flex-col">
                            <p className="text-gitpod-red text-sm">{errorMessage}</p>
                        </div>
                    </div>
                )}

            </div>
        </div>
    )
}

function NewTeam(props: {
    onSuccess: (team: Team) => void,
}) {
    const { setTeams } = useContext(TeamsContext);

    const [teamName, setTeamName] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();

    const onNewTeam = async () => {
        if (!teamName) {
            return;
        }
        try {
            const team = await getGitpodService().server.createTeam(teamName);
            setTeams(await getGitpodService().server.getTeams());
            props.onSuccess(team);
        } catch (error) {
            console.error(error);
            setError(error?.message || "Failed to create new team!");
        }
    }

    const onTeamNameChanged = (name: string) => {
        setTeamName(name);
        setError(undefined);
    }

    return <>
        <div className="mt-6 mb-1 flex flex-row space-x-2">
            <input type="text" className="py-1 min-w-0" name="new-team-inline" value={teamName} onChange={(e) => onTeamNameChanged(e.target.value)} />
            <button key={`new-team-inline-create`} disabled={!teamName} onClick={() => onNewTeam()}>Continue</button>
        </div>
        {error && <p className="text-gitpod-red">{error}</p>}
    </>;
}

async function openReconfigureWindow(params: { account?: string, onSuccess: (p: any) => void }) {
    const { account, onSuccess } = params;
    const state = btoa(JSON.stringify({ from: "/reconfigure", next: "/new" }));
    const url = gitpodHostUrl.withApi({
        pathname: '/apps/github/reconfigure',
        search: `account=${account}&state=${encodeURIComponent(state)}`
    }).toString();

    const width = 800;
    const height = 800;
    const left = (window.screen.width / 2) - (width / 2);
    const top = (window.screen.height / 2) - (height / 2);

    // Optimistically assume that the new window was opened.
    window.open(url, "gitpod-github-window", `width=${width},height=${height},top=${top},left=${left}status=yes,scrollbars=yes,resizable=yes`);

    const eventListener = (event: MessageEvent) => {
        // todo: check event.origin

        const killWindow = () => {
            window.removeEventListener("message", eventListener);

            if (event.source && "close" in event.source && event.source.close) {
                console.log(`Received Window Result. Closing Window.`);
                event.source.close();
            }
        }

        if (typeof event.data === "string" && event.data.startsWith("payload:")) {
            killWindow();
            try {
                let payload: { installationId: string, setupAction?: string } = JSON.parse(atob(event.data.substring("payload:".length)));
                onSuccess && onSuccess(payload);
            } catch (error) {
                console.log(error);
            }
        }
        if (typeof event.data === "string" && event.data.startsWith("error:")) {
            let error: string | { error: string, description?: string } = atob(event.data.substring("error:".length));
            try {
                const payload = JSON.parse(error);
                if (typeof payload === "object" && payload.error) {
                    error = { error: payload.error, description: payload.description };
                }
            } catch (error) {
                console.log(error);
            }

            killWindow();
            // onError && onError(error);
        }
    };
    window.addEventListener("message", eventListener);
}
