import { TestBed } from "@angular/core/testing";
import { of } from "rxjs";
import { EnvService } from "./config.service";

describe("EnvService", () => {
  let service: EnvService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [EnvService],
    });
    service = TestBed.inject(EnvService);

    // Spy on EnvService's getProxyEnvs() method
    spyOn(service, "getProxyEnvs").and.callFake(() => of({}));
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });
});
