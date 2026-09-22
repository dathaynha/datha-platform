import { provideHttpClient } from "@angular/common/http";
import { provideHttpClientTesting } from "@angular/common/http/testing";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { ActivatedRoute, convertToParamMap, Router } from "@angular/router";
import { TranslateModule } from "@ngx-translate/core";
import type { EventListResponse } from "@models/event.model";
import { EventsService } from "@services/implementations/events.service";
import { of, throwError } from "rxjs";

import { EventsPageComponent } from "./events-page.component";

describe("EventsPageComponent", () => {
  let component: EventsPageComponent;
  let fixture: ComponentFixture<EventsPageComponent>;
  let eventsService: jasmine.SpyObj<EventsService>;
  let router: jasmine.SpyObj<Router>;

  const emptyList: EventListResponse = { data: [], total: 0 };

  beforeEach(async () => {
    eventsService = jasmine.createSpyObj<EventsService>("EventsService", [
      "list",
      "listServices",
      "listTypes",
      "listPayloadKeys",
      "listPayloadValues",
    ]);
    eventsService.list.and.returnValue(of(emptyList));
    eventsService.listServices.and.returnValue(
      of(["api-gateway", "realtime-service"]),
    );
    eventsService.listTypes.and.returnValue(
      of(["file.deleted", "file.uploaded"]),
    );
    eventsService.listPayloadKeys.and.returnValue(of(["origin", "mime_type"]));
    eventsService.listPayloadValues.and.returnValue(of(["messenger"]));
    router = jasmine.createSpyObj<Router>("Router", ["navigate"]);
    router.navigate.and.returnValue(Promise.resolve(true));

    await TestBed.configureTestingModule({
      imports: [EventsPageComponent, TranslateModule.forRoot()],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: EventsService, useValue: eventsService },
        { provide: Router, useValue: router },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(EventsPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create and load the initial event list", () => {
    expect(component).toBeTruthy();
    expect(eventsService.list).toHaveBeenCalled();
    expect(component.total()).toBe(0);
  });

  it("offers the services the API reports, not a hard-coded list", () => {
    expect(eventsService.listServices).toHaveBeenCalled();
    expect(component.serviceOptions()).toEqual([
      "api-gateway",
      "realtime-service",
    ]);
  });

  // The type filter was free text over ten values, so a typo returned an empty
  // list that reads as "nothing of that kind happened".
  it("offers the event types the API reports", () => {
    expect(eventsService.listTypes).toHaveBeenCalled();
    expect(component.typeOptions()).toEqual(["file.deleted", "file.uploaded"]);
  });

  // The menu is a view over the comma-joined signal the URL state speaks, so a
  // selection has to survive the round trip rather than replace the format.
  it("keeps the comma-joined type filter as the value of record", () => {
    component.onTypesFilterChange(["file.uploaded", "file.deleted"]);

    expect(component.typeFilter()).toBe("file.deleted, file.uploaded");
    expect(component.typesSelected()).toEqual([
      "file.deleted",
      "file.uploaded",
    ]);
  });

  it("openDetail navigates to the event detail route", () => {
    const event = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "file.uploaded",
      service: "file-service",
      entityId: "ent-1",
      ownerId: "google_u1",
      correlationId: "corr-1",
      timestamp: "2026-01-01T12:00:00.000Z",
      payload: { size: 42 },
    };

    component.openDetail(event);
    expect(router.navigate).toHaveBeenCalledWith([event.id], {
      relativeTo: jasmine.any(Object),
      queryParamsHandling: "preserve",
    });
  });
});

/**
 * What the filter does when it cannot load its own options.
 *
 * The options used to be a constant, so there was nothing to fail. Fetching
 * them adds a failure mode, and the wrong answer to it is to fall back to that
 * constant — it offered a service with zero events and hid the two largest
 * publishers. Empty is the right degradation: no service filter at all.
 *
 * What must keep working through it is a filter that came from the URL. It is
 * held in `servicesFilter`, which the request and the chip both read directly,
 * so a bookmarked link still filters against a dropdown showing nothing.
 */
describe("EventsPageComponent when the service options fail to load", () => {
  let component: EventsPageComponent;
  let eventsService: jasmine.SpyObj<EventsService>;

  beforeEach(async () => {
    eventsService = jasmine.createSpyObj<EventsService>("EventsService", [
      "list",
      "listServices",
      "listTypes",
      "listPayloadKeys",
      "listPayloadValues",
    ]);
    eventsService.list.and.returnValue(of({ data: [], total: 0 }));
    eventsService.listServices.and.returnValue(
      throwError(() => new Error("gateway down")),
    );
    eventsService.listTypes.and.returnValue(
      throwError(() => new Error("gateway down")),
    );
    eventsService.listPayloadKeys.and.returnValue(of([]));
    eventsService.listPayloadValues.and.returnValue(of([]));

    const router = jasmine.createSpyObj<Router>("Router", ["navigate"]);
    router.navigate.and.returnValue(Promise.resolve(true));

    await TestBed.configureTestingModule({
      imports: [EventsPageComponent, TranslateModule.forRoot()],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: EventsService, useValue: eventsService },
        { provide: Router, useValue: router },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: convertToParamMap({ service: "realtime-service" }),
            },
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(EventsPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("renders the page with no options rather than failing", () => {
    expect(component.serviceOptions()).toEqual([]);
    expect(component.typeOptions()).toEqual([]);
    expect(eventsService.list).toHaveBeenCalled();
  });

  it("still applies the service filter that came from the URL", () => {
    expect(component.servicesFilter()).toEqual(["realtime-service"]);
    expect(eventsService.list).toHaveBeenCalledWith(
      jasmine.objectContaining({ services: ["realtime-service"] }),
    );
    expect(component.activeFilters()).toContain(
      jasmine.objectContaining({
        id: "service:realtime-service",
        labelParams: { value: "realtime-service" },
      }),
    );
  });
});
