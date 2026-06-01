import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { addTodo, deleteTodo, signOut } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ListTodo, LogOut, Plus, Trash2 } from "lucide-react";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: todos } = await supabase
    .from("todos")
    .select("id, task, inserted_at")
    .order("inserted_at", { ascending: true });

  const count = todos?.length ?? 0;

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ListTodo className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">TODOs</h1>
            <p className="text-xs text-muted-foreground">{user.email}</p>
          </div>
        </div>
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            <LogOut />
            Sign out
          </Button>
        </form>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Your tasks</CardTitle>
          <CardDescription>
            {count > 0
              ? `${count} ${count === 1 ? "task" : "tasks"}`
              : "Nothing here yet"}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <form action={addTodo} className="flex gap-2">
            <Input
              name="task"
              placeholder="Add a new task…"
              autoComplete="off"
              required
            />
            <Button type="submit">
              <Plus />
              Add
            </Button>
          </form>

          {count > 0 ? (
            <ul className="divide-y rounded-lg border">
              {todos!.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="text-sm">{t.task}</span>
                  <form action={deleteTodo}>
                    <input type="hidden" name="id" value={t.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete task"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 />
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
              No todos yet. Add your first task above.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
