import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { User } from "@shared/models/auth";
import { toast } from "@/hooks/use-toast";
import type { QueryClient } from "@tanstack/react-query";

async function fetchUser(): Promise<User | null> {
  const response = await fetch("/api/auth/user", {
    credentials: "include",
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`${response.status}: ${response.statusText}`);
  }

  return response.json();
}

export async function logout(): Promise<{localSignedOut:true,providerLogoutUrl:string|null}> {
  const response=await fetch("/api/logout",{
    method:"POST",credentials:"include",redirect:"error",
    headers:{"X-SRE-Logout":"1"},
  });
  if(!response.ok)throw new Error("Sign-out could not be confirmed. Please retry.");
  const result=await response.json();
  if(result.localSignedOut!==true ||
    !(result.providerLogoutUrl===null || typeof result.providerLogoutUrl==="string")){
    throw new Error("Sign-out could not be confirmed. Please retry.");
  }
  return result;
}
export async function finishLogout(result:{localSignedOut:true,providerLogoutUrl:string|null},cache:QueryClient,navigate:(url:string)=>void){
  await cache.cancelQueries();
  cache.clear();
  try{navigate(result.providerLogoutUrl ?? "/?localSignedOut=1");}
  catch{
    // Local success is not undone by a blocked provider navigation.
    try{navigate("/?localSignedOut=1");}catch{}
    return {localSignedOut:true,providerHandoffFailed:true};
  }
  return {localSignedOut:true,providerHandoffFailed:result.providerLogoutUrl===null};
}

export function useAuth() {
  const queryClient = useQueryClient();
  const { data: user, isLoading } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: fetchUser,
    retry: false,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: async result => {
      // A provider handoff must be top-level navigation, never a fetch redirect.
      // Full navigation also removes in-memory account state from the old page.
      const outcome=await finishLogout(result,queryClient,url=>window.location.replace(url));
      if(outcome.providerHandoffFailed)toast({title:"Local sign-out complete",description:"Provider sign-out could not be opened. Your provider account may still be signed in."});
    },
    onError:()=>toast({title:"Sign-out not confirmed",description:"Please retry. Your account state has not been cleared.",variant:"destructive"}),
  });

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
  };
}
