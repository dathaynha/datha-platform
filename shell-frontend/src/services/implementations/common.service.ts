import { Injectable } from "@angular/core";
import { User } from "@models/index";
import { BehaviorSubject } from "rxjs";

@Injectable({
  providedIn: "root",
})
export class CommonService {
  private loadingSubject = new BehaviorSubject<boolean>(false);
  private currentUserSubject = new BehaviorSubject<User | null>(null);

  loading$ = this.loadingSubject.asObservable();
  currentUser$ = this.currentUserSubject.asObservable();

  setLoading(loading: boolean): void {
    this.loadingSubject.next(loading);
  }

  setCurrentUser(user: User): void {
    this.currentUserSubject.next(user);
  }

  getCurrentUser(): User | null {
    return this.currentUserSubject.getValue();
  }
}
